FROM node:22-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && pip3 install --no-cache-dir --break-system-packages -U yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV HOST=0.0.0.0 \
    PORT=10000 \
    CLIPS_DIR=/tmp/clips \
    CLIP_TTL_MINUTES=60 \
    MAX_CLIP_SECONDS=600 \
    MAX_PARALLEL=1

EXPOSE 10000
USER node
CMD ["node", "server.js"]
