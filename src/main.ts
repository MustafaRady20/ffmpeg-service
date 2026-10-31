import { NestFactory } from '@nestjs/core';
import { mkdirSync } from 'fs';
import { AppModule } from './app.module';
import { MIN_API_KEY_LENGTH } from './auth/api-key.guard';

const UPLOAD_DIR = process.env.UPLOAD_DIR ?? '/tmp/uploads';
const OUTPUT_DIR = process.env.OUTPUT_DIR ?? '/tmp/outputs';

async function bootstrap() {
  // Refuse to start unprotected: every endpoint except /health needs this key.
  const apiKey = process.env.COMPRESSOR_API_KEY ?? '';
  if (apiKey.length < MIN_API_KEY_LENGTH) {
    throw new Error(
      `COMPRESSOR_API_KEY must be set to at least ${MIN_API_KEY_LENGTH} characters ` +
        '(generate one with: openssl rand -hex 32)',
    );
  }

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
