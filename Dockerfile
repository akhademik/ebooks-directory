FROM node:22-slim

RUN apt-get update && apt-get install -y \
       ca-certificates curl \
       fonts-freefont-ttf \
       libxss1 \
       --no-install-recommends \
    && curl -fsSL "https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb" \
       -o /tmp/chrome.deb \
    && apt-get install -y /tmp/chrome.deb \
    && apt-get purge -y --auto-remove curl \
    && rm /tmp/chrome.deb \
    && rm -rf /var/lib/apt/lists/* /tmp/* /var/tmp/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

WORKDIR /app

COPY backend/package*.json ./backend/
RUN npm install --prefix backend --omit=dev

COPY backend/ ./backend/
COPY frontend/ ./frontend/

RUN mkdir -p backend/storage

EXPOSE 3000
CMD ["/bin/sh", "-c", "rm -f /app/core && rm -f /app/backend/storage/*.json && node backend/server.js"]