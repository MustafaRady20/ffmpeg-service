import { NestFactory } from '@nestjs/core';
import { mkdirSync } from 'fs';
import { AppModule } from './app.module';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/uploads';
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? '/tmp/outputs';

async function bootstrap() {
  // Make sure the working directories exist before any request lands.
  mkdirSync(UPLOAD_DIR, { recursive: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const app = await NestFactory.create(AppModule);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port);

  // eslint-disable-next-line no-console
  console.log(`Video compression service listening on :${port}`);
}

bootstrap();
