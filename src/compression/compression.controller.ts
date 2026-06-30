import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
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
import {
  COMPRESSION_QUEUE,
  CompressionJobData,
  CompressionJobResult,
} from './compression.queue';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/uploads';
const MAX_UPLOAD_BYTES = Number(
  process.env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024 * 1024,
);

@Controller()
export class CompressionController {
  constructor(
    @InjectQueue(COMPRESSION_QUEUE)
    private readonly queue: Queue<CompressionJobData>,
  ) {}

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
  ): Promise<{ jobId: string }> {
    if (!file) {
      throw new BadRequestException('No file uploaded under form field "video"');
    }

    const job = await this.queue.add('compress', {
      inputPath: file.path,
      originalName: file.originalname,
      generateSubtitles: generateSubtitles === 'true',
    });

    return { jobId: job.id! };
  }

  @Get('jobs/:id/status')
  async status(@Param('id') id: string) {
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
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    const state = await job.getState();
    if (state !== 'completed') {
      throw new BadRequestException(`Job is not ready (status: ${state})`);
    }

    const { servePath, discardPath, serveSize, originalName, subtitlePath } =
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
      if (subtitlePath) unlink(subtitlePath).catch(() => undefined);
      job.remove().catch(() => undefined);
    });

    return new StreamableFile(stream);
  }

  @Get('jobs/:id/subtitle')
  async subtitle(
    @Param('id') id: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const job = await this.queue.getJob(id);
    if (!job) throw new NotFoundException(`Job ${id} not found`);

    const state = await job.getState();
    if (state !== 'completed') {
      throw new BadRequestException(`Job is not ready (status: ${state})`);
    }

    const { subtitlePath } = job.returnvalue as CompressionJobResult;
    if (!subtitlePath) {
      throw new NotFoundException('No subtitle was generated for this job');
    }

    res.set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="subtitle.srt"',
    });

    return new StreamableFile(createReadStream(subtitlePath));
  }
}
