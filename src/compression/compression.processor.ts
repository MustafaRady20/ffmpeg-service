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
    const { inputPath, originalName } = job.data;
    this.logger.log(`[job ${job.id}] starting encode for ${originalName}`);

    let outputPath: string;
    try {
      outputPath = await this.compression.compress(inputPath, (pct) =>
        job.updateProgress(pct),
      );
    } catch (err) {
      await unlink(inputPath).catch(() => undefined);
      throw err;
    }

    const [inStat, outStat] = await Promise.all([
      stat(inputPath),
      stat(outputPath),
    ]);

    const servePath = outStat.size < inStat.size ? outputPath : inputPath;
    const discardPath = servePath === outputPath ? inputPath : outputPath;
    const serveSize = servePath === outputPath ? outStat.size : inStat.size;

    this.logger.log(
      `[job ${job.id}] done — serving ${servePath} (${serveSize} bytes)`,
    );

    return { servePath, discardPath, serveSize, originalName };
  }
}
