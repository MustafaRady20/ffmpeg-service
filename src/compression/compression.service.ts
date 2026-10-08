import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { stat, unlink } from 'fs/promises';
import { join, resolve } from 'path';

const OUTPUT_DIR = process.env.OUTPUT_DIR ?? '/tmp/outputs';
// CRF 30 + preset 'slow' trade encode time for a meaningfully better
// compression ratio than CRF 28 + 'fast' at the same resolution — the
// previous defaults were frequently failing to beat the source file at all
// (see mia's evaluation upload testing), so useOutput's "keep whichever is
// smaller" check kept silently falling back to serving the original.
const CRF = process.env.FFMPEG_CRF ?? '30';
const PRESET = process.env.FFMPEG_PRESET ?? 'slow';
const VCODEC = process.env.FFMPEG_VCODEC ?? 'libx264';
const ABITRATE = process.env.FFMPEG_ABITRATE ?? '128k';
const TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS ?? 30 * 60 * 1000);
// CRF targets a quality level, not a size, so on an already well-compressed
// upload it can spend more bits than the source has. Capping the video bitrate
// at this fraction of the source's makes the encode come out smaller anyway.
// 0 disables the cap.
const MAX_BITRATE_RATIO = Number(process.env.FFMPEG_MAX_BITRATE_RATIO ?? 0.75);

interface SourceInfo {
  videoBitrate?: number;
  audioBitrate?: number;
  audioCodec?: string;
}

function parseBitrate(value: string): number {
  const m = /^(\d+(?:\.\d+)?)([kM]?)$/.exec(value.trim());
  if (!m) return NaN;
  return Number(m[1]) * (m[2] === 'M' ? 1e6 : m[2] === 'k' ? 1e3 : 1);
}

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
    subtitleLanguage?: string,
    diarize = false,
  ): Promise<{ outputPath: string; subtitlePath?: string }> {
    const outputPath = join(OUTPUT_DIR, `${randomUUID()}.mp4`);

    const source = await this.probeSource(inputPath);
    const maxrate =
      MAX_BITRATE_RATIO > 0 && source.videoBitrate
        ? Math.floor(source.videoBitrate * MAX_BITRATE_RATIO)
        : 0;

    // Never spend more bits on audio than the source has: keep an AAC track
    // that is already within budget as-is, otherwise re-encode at the lower
    // of the source bitrate and ABITRATE.
    const audioBudget = parseBitrate(ABITRATE);
    const { audioBitrate, audioCodec } = source;
    const audioArgs =
      audioCodec === 'aac' && audioBitrate && audioBitrate <= audioBudget
        ? ['-c:a', 'copy']
        : [
            '-c:a', 'aac',
            '-b:a', audioBitrate && audioBitrate < audioBudget ? String(audioBitrate) : ABITRATE,
          ];

    const isNvenc = VCODEC.includes('nvenc');
    const args = [
      '-i', inputPath,
      '-c:v', VCODEC,
      ...(isNvenc ? ['-rc:v', 'vbr', '-cq', CRF] : ['-crf', CRF]),
      ...(maxrate ? ['-maxrate', String(maxrate), '-bufsize', String(maxrate * 2)] : []),
      '-preset', PRESET,
      ...audioArgs,
      '-movflags', '+faststart',
      '-y',
      outputPath,
    ];

    this.logger.log(
      `Encoding ${inputPath} -> ${outputPath}` +
        (maxrate ? ` (video capped at ${maxrate} b/s)` : ''),
    );
    await this.runFfmpeg(args, onProgress);

    if (generateSubtitles) {
      try {
        return await this.addGeneratedSubtitles(inputPath, outputPath, subtitleLanguage, diarize);
      } catch (err) {
        this.logger.warn(
          `Subtitle generation failed, returning video without subtitles: ${err}`,
        );
      }
    }

    return { outputPath };
  }

  private async addGeneratedSubtitles(
    inputPath: string,
    encodedPath: string,
    targetLanguage?: string,
    diarize = false,
  ): Promise<{ outputPath: string; subtitlePath: string }> {
    // WAV (16 kHz mono) is required by pyannote for diarization and works
    // equally well for Whisper transcription.
    const audioPath = join(OUTPUT_DIR, `${randomUUID()}.wav`);
    const srtPath   = join(OUTPUT_DIR, `${randomUUID()}.srt`);

    try {
      this.logger.log('Extracting audio for transcription…');
      await this.runFfmpeg([
        '-i', encodedPath,
        '-vn', '-ar', '16000', '-ac', '1',
        '-y', audioPath,
      ]);

      this.logger.log('Transcribing audio with local Whisper…');
      await this.runWhisper(audioPath, srtPath, targetLanguage, diarize);

      // The subtitle track must not force a bigger file than the upload: if
      // the encode failed to shrink it, carry the subtitles on the original
      // instead (falling back to the encode when its streams don't fit MP4).
      const [inStat, encStat] = await Promise.all([stat(inputPath), stat(encodedPath)]);
      const bases =
        encStat.size < inStat.size ? [encodedPath] : [inputPath, encodedPath];
      const finalPath = await this.muxSubtitles(bases, srtPath);

      await unlink(encodedPath).catch(() => undefined);
      // srtPath is intentionally kept — caller will serve and clean it up
      return { outputPath: finalPath, subtitlePath: srtPath };
    } catch (err) {
      await unlink(srtPath).catch(() => undefined);
      throw err;
    } finally {
      await unlink(audioPath).catch(() => undefined);
    }
  }

  // Muxes the subtitle track into the first base video that accepts it.
  private async muxSubtitles(bases: string[], srtPath: string): Promise<string> {
    let lastErr: unknown;
    for (const videoPath of bases) {
      const finalPath = join(OUTPUT_DIR, `${randomUUID()}.mp4`);
      try {
        this.logger.log(`Muxing subtitle track into ${videoPath}…`);
        await this.runFfmpeg([
          '-i', videoPath,
          '-i', srtPath,
          '-map', '0:v:0', '-map', '0:a:0?', '-map', '1:0',
          '-c:v', 'copy',
          '-c:a', 'copy',
          '-c:s', 'mov_text',
          '-movflags', '+faststart',
          '-y', finalPath,
        ]);
        return finalPath;
      } catch (err) {
        lastErr = err;
        await unlink(finalPath).catch(() => undefined);
      }
    }
    throw lastErr;
  }

  // Best effort: an unreadable bitrate just means the encode runs uncapped.
  private probeSource(inputPath: string): Promise<SourceInfo> {
    return new Promise<SourceInfo>((resolve) => {
      const probe = spawn('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=bit_rate:stream=codec_type,codec_name,bit_rate',
        '-of', 'json',
        inputPath,
      ]);

      let stdout = '';
      probe.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      probe.on('error', (err) => {
        this.logger.warn(`Could not start ffprobe: ${err.message}`);
        resolve({});
      });
      probe.on('close', () => {
        try {
          const { streams = [], format = {} } = JSON.parse(stdout);
          const video = streams.find((s: any) => s.codec_type === 'video');
          const audio = streams.find((s: any) => s.codec_type === 'audio');
          const audioBitrate = Number(audio?.bit_rate) || undefined;
          const total = Number(format.bit_rate) || undefined;
          // Containers like MKV/WebM carry no per-stream bitrate, so derive
          // the video share from the overall one.
          const videoBitrate =
            Number(video?.bit_rate) ||
            (total ? total - (audioBitrate ?? 0) : undefined);
          resolve({ videoBitrate, audioBitrate, audioCodec: audio?.codec_name });
        } catch {
          this.logger.warn(`Could not probe ${inputPath}, encoding without a bitrate cap`);
          resolve({});
        }
      });
    });
  }

  private runWhisper(audioPath: string, srtPath: string, targetLanguage?: string, diarize = false): Promise<void> {
    const model = process.env.WHISPER_MODEL ?? 'small';
    const script = resolve(__dirname, '../../scripts/whisper_srt.py');
    // Always pass targetLanguage as positional arg (empty string = no translation)
    // so the optional diarize flag stays in a fixed position.
    const args = [script, audioPath, srtPath, model, targetLanguage ?? '', ...(diarize ? ['diarize'] : [])];

    return new Promise<void>((resolve, reject) => {
      const py = spawn('python3', args);

      let stderr = '';
      py.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        this.logger.log(text.trim());
      });
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
