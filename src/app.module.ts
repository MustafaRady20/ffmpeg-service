import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CompressionModule } from './compression/compression.module';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD,
      },
    }),
    CompressionModule,
  ],
})
export class AppModule {}
