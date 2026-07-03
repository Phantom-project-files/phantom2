# Phantom 2.0 backend — Fly.io image.
FROM node:22-slim

# Phase 5 runtime deps: ffmpeg (beat-cut editor + graphics pass) and chromium
# (post composer screenshots). CHROME_PATH points post-compose at the system bin.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg chromium fonts-liberation \
  && rm -rf /var/lib/apt/lists/*
ENV CHROME_PATH=/usr/bin/chromium

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3020
CMD ["node", "server.js"]
