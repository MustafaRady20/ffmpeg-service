import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { unlink } from 'fs/promises';
import { join, resolve } from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? '/tmp/outputs';
const CRF = process.env.FFMPEG_CRF ?? '28';
const PRESET = process.env.FFMPEG_PRESET ?? 'fast';
const VCODEC = process.env.FFMPEG_VCODEC ?? 'libx264';
const ABITRATE = process.env.FFMPEG_ABITRATE ?? '128k';
const TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS ?? 30 * 60 * 1000);

function parseSeconds(timestamp: string): number {
  const [h, m, s] = timestamp.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

@Injectable()
export class CompressionService {
  private readonly logger = new Logger(CompressionService.name);

  async compress(
    inputPath: string,
    generateSubtitles = false,
    onProgress?: (pct: number) => void,
  ): Promise<string> {
    const outputPath = join(OUTPUT_DIR, `${randomUUID()}.mp4`);

    const isNvenc = VCODEC.includes('nvenc');
    const args = [
      '-i', inputPath,
      '-c:v', VCODEC,
      ...(isNvenc ? ['-rc:v', 'vbr', '-cq', CRF] : ['-crf', CRF]),
      '-preset', PRESET,
      '-c:a', 'aac',
      '-b:a', ABITRATE,
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ];

    this.logger.log(`Encoding ${inputPath} -> ${outputPath}`);
    await this.runFfmpeg(args, onProgress);

    if (generateSubtitles) {
      try {
        return await this.addGeneratedSubtitles(outputPath);
      } catch (err) {
        this.logger.warn(
          `Subtitle generation failed, returning video without subtitles: ${err}`,
        );
      }
    }

    return outputPath;
  }

  private async addGeneratedSubtitles(videoPath: string): Promise<string> {
    const audioPath = join(OUTPUT_DIR, `${randomUUID()}.mp3`);
    const srtPath   = join(OUTPUT_DIR, `${randomUUID()}.srt`);
    const finalPath = join(OUTPUT_DIR, `${randomUUID()}.mp4`);

    try {
      this.logger.log('Extracting audio for transcription…');
      await this.runFfmpeg([
        '-i', videoPath,
        '-vn', '-ar', '16000', '-ac', '1', '-b:a', '16k',
        '-y', audioPath,
      ]);

      this.logger.log('Transcribing audio with local Whisper…');
      await this.runWhisper(audioPath, srtPath);

      this.logger.log('Muxing subtitle track into video…');
      await this.runFfmpeg([
        '-i', videoPath,
        '-i', srtPath,
        '-c:v', 'copy',
        '-c:a', 'copy',
        '-c:s', 'mov_text',
        '-y', finalPath,
      ]);

      await unlink(videoPath).catch(() => undefined);
      return finalPath;
    } finally {
      await unlink(audioPath).catch(() => undefined);
      await unlink(srtPath).catch(() => undefined);
    }
  }

  private runWhisper(audioPath: string, srtPath: string): Promise<void> {
    const model = process.env.WHISPER_MODEL ?? 'small';
    const script = resolve(__dirname, '../../scripts/whisper_srt.py');

    return new Promise<void>((resolve, reject) => {
      const py = spawn('python3', [script, audioPath, srtPath, model]);

      let stderr = '';
      py.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      py.stdout.on('data', (chunk: Buffer) => { this.logger.log(chunk.toString().trim()); });

      py.on('error', (err) =>
        reject(new Error(`Could not start Python: ${err.message}`)),
      );
      py.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Whisper exited ${code}: ${stderr.slice(-500)}`));
      });
    });
  }

  private runFfmpeg(
    args: string[],
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', args);

      let stderrBuf = '';
      let durationSecs = 0;
      let timedOut = false;

      const timeout =
        TIMEOUT_MS > 0
          ? setTimeout(() => {
              timedOut = true;
              ff.kill('SIGKILL');
            }, TIMEOUT_MS)
          : undefined;

      ff.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderrBuf = (stderrBuf + text).slice(-2000);

        if (!durationSecs) {
          const m = /Duration:\s*(\d+:\d+:\d+\.\d+)/.exec(stderrBuf);
          if (m) durationSecs = parseSeconds(m[1]);
        }

        if (onProgress && durationSecs) {
          const m = /time=(\d+:\d+:\d+\.\d+)/.exec(text);
          if (m) {
            const pct = Math.min(
              99,
              Math.round((parseSeconds(m[1]) / durationSecs) * 100),
            );
            onProgress(pct);
          }
        }
      });

      ff.on('error', (err) => {
        clearTimeout(timeout);
        reject(
          new InternalServerErrorException(
            `Could not start FFmpeg (is it installed and on PATH?): ${err.message}`,
          ),
        );
      });

      ff.on('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          return reject(
            new InternalServerErrorException(
              `FFmpeg exceeded timeout of ${TIMEOUT_MS}ms`,
            ),
          );
        }
        if (code === 0) return resolve();
        this.logger.error(`FFmpeg exited ${code}\n${stderrBuf}`);
        reject(
          new InternalServerErrorException(`FFmpeg exited with code ${code}`),
        );
      });
    });
  }
}
