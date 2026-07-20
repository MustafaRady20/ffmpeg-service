import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { stat, unlink } from 'fs/promises';
import {
  COMPRESSION_QUEUE,
  CompressionJobData,
  CompressionJobResult,
} from './compression.queue';
import { CompressionService } from './compression.service';

const CONCURRENCY = Number(process.env.COMPRESSION_CONCURRENCY ?? 2);

@Processor(COMPRESSION_QUEUE, { concurrency: CONCURRENCY })
export class CompressionProcessor extends WorkerHost {
  private readonly logger = new Logger(CompressionProcessor.name);

  constructor(private readonly compression: CompressionService) {
    super();
  }

  async process(job: Job<CompressionJobData>): Promise<CompressionJobResult> {
    const { inputPath, originalName, generateSubtitles, subtitleLanguage, diarize } = job.data;
    this.logger.log(`[job ${job.id}] starting encode for ${originalName}`);

    let result: { outputPath: string; subtitlePath?: string };
    try {
      result = await this.compression.compress(
        inputPath,
        generateSubtitles ?? false,
        (pct: number) => job.updateProgress(pct),
        subtitleLanguage,
        diarize ?? false,
      );
    } catch (err) {
      await unlink(inputPath).catch(() => undefined);
      throw err;
    }

    const { outputPath, subtitlePath } = result;
    const [inStat, outStat] = await Promise.all([
      stat(inputPath),
      stat(outputPath),
    ]);

    // If subtitles were generated the output always wins (it has the subtitle track).
    // Otherwise pick whichever file is smaller.
    const useOutput = generateSubtitles || outStat.size < inStat.size;
    const servePath = useOutput ? outputPath : inputPath;
    const discardPath = useOutput ? inputPath : outputPath;
    const serveSize = useOutput ? outStat.size : inStat.size;

    this.logger.log(
      `[job ${job.id}] done — serving ${servePath} (${serveSize} bytes)`,
    );

    return { servePath, discardPath, serveSize, originalName, subtitlePath };
  }
}
