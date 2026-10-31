import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { randomUUID } from 'crypto';
import { createReadStream } from 'fs';
import { unlink } from 'fs/promises';
import { extname } from 'path';
import { Queue } from 'bullmq';
import type { Response } from 'express';
import { Public } from '../auth/api-key.guard';
import {
  COMPRESSION_QUEUE,
  CompressionJobData,
  CompressionJobResult,
} from './compression.queue';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/uploads';
const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024 * 1024,
);

// Completed jobs are kept in Redis for this long so all outputs (video +
// optional subtitle) can be downloaded regardless of order. After expiry
// BullMQ removes them automatically — no manual job.remove() needed.
const JOB_TTL_SECONDS = 6 * 60 * 60; // 6 hours

// Job IDs are random UUIDs; anything else is rejected before touching Redis.
const JOB_ID_PIPE = new ParseUUIDPipe({ version: '4' });

@Controller()
export class CompressionController {
  constructor(
    @InjectQueue(COMPRESSION_QUEUE)
    private readonly queue: Queue<CompressionJobData>,
  ) {}

  @Public()
  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Post('compress')
  @HttpCode(202)
  @UseInterceptors(
    FileInterceptor('video', {
      storage: diskStorage({
        destination: UPLOAD_DIR,
        filename: (_req, file, cb) =>
          cb(null, `${randomUUID()}${extname(file.originalname) || '.mp4'}`),
      }),
      limits: { fileSize: MAX_UPLOAD_BYTES },
      fileFilter: (_req, file, cb) => {
        const t = file.mimetype;
        const obviouslyWrong =
          t.startsWith('image/') ||
          t.startsWith('text/') ||
          t.startsWith('audio/');
        if (obviouslyWrong) {
          return cb(new BadRequestException(`Unsupported type: ${t}`), false);
        }
        cb(null, true);
      },
    }),
  )
  async enqueue(
    @UploadedFile() file: Express.Multer.File,
    @Body('generateSubtitles') generateSubtitles?: string,
    @Body('subtitleLanguage') subtitleLanguage?: string,
    // Spoken language (e.g. 'ja'). Omit to auto-detect.
    @Body('sourceLanguage') sourceLanguage?: string,
    @Body('diarize') diarize?: string,
  ): Promise<{ jobId: string }> {
    if (!file) {
      throw new BadRequestException('No file uploaded under form field "video"');
    }

    const job = await this.queue.add(
      'compress',
      {
        inputPath: file.path,
        originalName: file.originalname,
        generateSubtitles: generateSubtitles === 'true',
        subtitleLanguage: subtitleLanguage || undefined,
        sourceLanguage: sourceLanguage || undefined,
        diarize: diarize === 'true',
      },
      {
        // BullMQ's default IDs count up (1, 2, 3…), so anyone could guess
        // other jobs' IDs and fetch their videos. A random UUID can't be guessed.
        jobId: randomUUID(),
        removeOnComplete: { age: JOB_TTL_SECONDS },
        removeOnFail: { age: 24 * 60 * 60 }, // keep failed jobs 24 h for debugging
      },
    );

    return { jobId: job.id! };
  }

  @Get('jobs/:id/status')
  async status(@Param('id', JOB_ID_PIPE) id: string) {
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    const state = await job.getState();
    const response: Record<string, unknown> = { jobId: id, status: state };
    if (state === 'active') response.progress = job.progress;
    if (state === 'failed') response.failedReason = job.failedReason;
    return response;
  }

  @Get('jobs/:id/download')
  async download(
    @Param('id', JOB_ID_PIPE) id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    const state = await job.getState();
    if (state !== 'completed') {
      throw new BadRequestException(`Job is not ready (status: ${state})`);
    }

    const { servePath, discardPath, serveSize, originalName } =
      job.returnvalue as CompressionJobResult;

    const baseName = originalName.replace(/\.[^.]+$/, '');
    res.set({
      'Content-Type': 'video/mp4',
      'Content-Length': serveSize.toString(),
      'Content-Disposition': `attachment; filename="compressed-${baseName}.mp4"`,
    });

    const stream = createReadStream(servePath);
    stream.on('close', () => {
      unlink(servePath).catch(() => undefined);
      unlink(discardPath).catch(() => undefined);
      // Job is cleaned up automatically via removeOnComplete TTL — no manual
      // removal here so the subtitle endpoint can still be called after this.
    });

    return new StreamableFile(stream);
  }

  @Get('jobs/:id/subtitle')
  async subtitle(
    @Param('id', JOB_ID_PIPE) id: string,
    @Res({ passthrough: true }) res: Response,
    // 'original' (default) = spoken language, 'translated' = DeepL translation
    @Query('track') track?: string,
  ): Promise<StreamableFile> {
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    const state = await job.getState();
    if (state !== 'completed') {
      throw new BadRequestException(`Job is not ready (status: ${state})`);
    }

    if (track && track !== 'original' && track !== 'translated') {
      throw new BadRequestException('track must be "original" or "translated"');
    }
    const translated = track === 'translated';
    const result = job.returnvalue as CompressionJobResult;
    const subtitlePath = translated ? result.translatedSubtitlePath : result.subtitlePath;
    if (!subtitlePath) {
      throw new NotFoundException(
        translated
          ? 'No translated subtitle was generated for this job'
          : 'No subtitle was generated for this job',
      );
    }

    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="${translated ? 'subtitle.translated' : 'subtitle'}.srt"`,
    });

    const srtStream = createReadStream(subtitlePath);
    srtStream.on('close', () => {
      unlink(subtitlePath).catch(() => undefined);
      // Job is cleaned up automatically via removeOnComplete TTL.
    });

    return new StreamableFile(srtStream);
  }
}
