FROM node:20-bookworm-slim

# FFmpeg is the open-source compression engine — this line is the "tool" you
# self-host. Everything else is just the NestJS wrapper around it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build && npm prune --omit=dev

ENV PORT=7000 \
    UPLOAD_DIR=/data/uploads \
    OUTPUT_DIR=/data/outputs

RUN mkdir -p /data/uploads /data/outputs

EXPOSE 7000
CMD ["node", "dist/main"]
