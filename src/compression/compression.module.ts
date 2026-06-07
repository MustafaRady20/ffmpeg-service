import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CompressionController } from './compression.controller';
import { CompressionService } from './compression.service';
import { CompressionProcessor } from './compression.processor';
import { COMPRESSION_QUEUE } from './compression.queue';

@Module({
  imports: [
    BullModule.registerQueue({
      name: COMPRESSION_QUEUE,
      defaultJobOptions: {
        removeOnComplete: false, // keep returnvalue available for /download
        removeOnFail: { age: 24 * 3600 },
      },
    }),
  ],
  controllers: [CompressionController],
  providers: [CompressionService, CompressionProcessor],
})
export class CompressionModule {}
