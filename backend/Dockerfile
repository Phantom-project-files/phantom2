# Phantom 2.0 backend — Fly.io image.
# Phase 5 will add ffmpeg + chromium (beat-cut editor + Remotion/post renders);
# keep the base slim until then.
FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3020
CMD ["node", "server.js"]
