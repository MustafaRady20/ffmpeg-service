# Video compression service

A small, self-hosted NestJS service that accepts a video over HTTP, compresses
it with **FFmpeg**, and streams the smaller file back in the response.

The "tool you self-host" is FFmpeg. This project is just a thin, well-behaved
NestJS wrapper around it.

## What it does

- `POST /compress` — multipart upload (field name `video`), returns the
  compressed `video/mp4` in the response body.
- `GET /health` — liveness check.
- Uploads stream to disk (never buffered in memory), so multi-GB files are fine.
- If the compressed result isn't actually smaller, the original is returned
  instead — the caller never gets a bigger file back.
- Temp files are deleted after the response is sent.

## Run with Docker (recommended)

The Dockerfile installs FFmpeg for you.

```bash
docker build -t video-compressor .
docker run -p 3000:3000 -v "$PWD/data:/data" video-compressor
```

## Run locally

Requires FFmpeg on the host (`ffmpeg -version` must work).

```bash
# Debian/Ubuntu: sudo apt install ffmpeg
# macOS:         brew install ffmpeg
npm install
npm run start:prod
```

## API

### `POST /compress`

| | |
|---|---|
| Content-Type | `multipart/form-data` |
| Field | `video` (the file) |
| Returns | `video/mp4` stream, `Content-Disposition: attachment` |

Quick test with curl:

```bash
curl -X POST http://localhost:3000/compress \
  -F "video=@./big-clip.mov" \
  -o compressed.mp4
```

### Calling it from your other app (Node)

```ts
import { createReadStream } from 'fs';
import FormData from 'form-data';
import axios from 'axios';

const form = new FormData();
form.append('video', createReadStream('big-clip.mov'));

const res = await axios.post('http://compressor:3000/compress', form, {
  headers: form.getHeaders(),
  responseType: 'stream',          // stream the result straight to disk/storage
  maxBodyLength: Infinity,
  maxContentLength: Infinity,
  timeout: 30 * 60 * 1000,
});

res.data.pipe(createWriteStream('compressed.mp4'));
```

Keep the **size gate in the calling app** as you planned: only POST to
`/compress` when the file is over your 750 MB threshold; send smaller files
straight to storage untouched.

## Configuration

All optional — see `.env.example`. The encoding knobs:

| Var | Default | Notes |
|---|---|---|
| `FFMPEG_CRF` | `28` | Quality/size dial. Lower = bigger + better (23-28 useful). |
| `FFMPEG_PRESET` | `medium` | Slower preset = smaller file, more CPU. |
| `FFMPEG_VCODEC` | `libx264` | `libx265` for ~40-50% smaller (slower); `h264_nvenc` for GPU. |
| `MAX_UPLOAD_BYTES` | `5368709120` | 5 GB upload cap. |

### Smaller files vs. faster encodes

- Want the **smallest files**: set `FFMPEG_VCODEC=libx265` and a slower preset.
  This is CPU-bound and the best choice when the goal is storage savings.
- Want **speed/throughput** on your GPU box: `FFMPEG_VCODEC=h264_nvenc`. This
  needs an NVENC-enabled FFmpeg build in the image and the NVIDIA Container
  Toolkit (`docker run --gpus all ...`). Note NVENC trades compression
  efficiency for speed — files come out a bit larger at equal quality.

## Important: synchronous vs. asynchronous

This service holds the HTTP connection open for the whole encode. That's simple
and fine for short jobs, but for 750 MB+ videos that take minutes it's fragile —
one dropped connection loses the work, and there are no retries.

For production at that size, prefer the async pattern: the caller uploads to
shared object storage (S3/MinIO), enqueues a BullMQ job carrying only the
storage key, a worker on the GPU box runs FFmpeg, writes the result back to
storage, and the caller is notified (webhook/poll) with a download URL. The
FFmpeg logic in `compression.service.ts` drops straight into that worker
unchanged — only the transport around it changes.
