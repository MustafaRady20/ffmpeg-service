import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { join } from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? '/tmp/outputs';

// Encoding knobs — override via env without touching code.
// CRF: quality/size dial (lower = bigger + better; 23-28 is the useful range).
// VCODEC: libx264 (broad compatibility) or libx265 (~40-50% smaller, slower).
//         For GPU speed use h264_nvenc / hevc_nvenc (see README — needs an
//         NVENC-enabled FFmpeg build and the NVIDIA container toolkit).
const CRF = process.env.FFMPEG_CRF ?? '28';
const PRESET = process.env.FFMPEG_PRESET ?? 'medium';
const VCODEC = process.env.FFMPEG_VCODEC ?? 'libx264';
const ABITRATE = process.env.FFMPEG_ABITRATE ?? '128k';

@Injectable()
export class CompressionService {
  private readonly logger = new Logger(CompressionService.name);

  /**
   * Compresses the file at `inputPath` and resolves with the path to the
   * compressed MP4. Throws if FFmpeg is missing or exits non-zero.
   */
  async compress(inputPath: string): Promise<string> {
    const outputPath = join(OUTPUT_DIR, `${randomUUID()}.mp4`);

    const args = [
      '-i', inputPath,
      '-c:v', VCODEC,
      '-crf', CRF,
      '-preset', PRESET,
      '-c:a', 'aac',
      '-b:a', ABITRATE,
      '-movflags', '+faststart', // lets the result start playing before fully downloaded
      '-y',
      outputPath,
    ];

    this.logger.log(`Encoding ${inputPath} -> ${outputPath}`);

    await new Promise<void>((resolve, reject) => {
      const ff = spawn('ffmpeg', args);

      let stderrTail = '';
      ff.stderr.on('data', (chunk: Buffer) => {
        // Keep only the tail so a long encode doesn't balloon memory.
        stderrTail = (stderrTail + chunk.toString()).slice(-2000);
      });

      ff.on('error', (err) =>
        reject(
          new InternalServerErrorException(
            `Could not start FFmpeg (is it installed and on PATH?): ${err.message}`,
          ),
        ),
      );

      ff.on('close', (code) => {
        if (code === 0) return resolve();
        this.logger.error(`FFmpeg exited ${code}\n${stderrTail}`);
        reject(new InternalServerErrorException(`FFmpeg exited with code ${code}`));
      });
    });

    return outputPath;
  }
}
