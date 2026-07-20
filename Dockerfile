FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages \
       faster-whisper \
       pyannote.audio \
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
# preload.py warms the Whisper model before the Node service starts accepting requests.
CMD ["sh", "-c", "python3 /app/scripts/preload.py; node dist/main"]
