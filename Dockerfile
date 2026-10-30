FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages \
       faster-whisper \
       pyannote.audio \
       nvidia-cublas-cu12 \
       "nvidia-cudnn-cu12>=9,<10" \
    && rm -rf /var/lib/apt/lists/*

# faster-whisper (CTranslate2) needs CUDA 12 cuBLAS + cuDNN 9 on the GPU. The
# pip wheels above ship them, but not on the loader path, so register them.
RUN python3 -c "import nvidia.cublas.lib as a, nvidia.cudnn.lib as b; print(list(a.__path__)[0]); print(list(b.__path__)[0])" \
       > /etc/ld.so.conf.d/nvidia-pip.conf \
    && ldconfig

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
