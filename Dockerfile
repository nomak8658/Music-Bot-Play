FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv python3-full \
    ffmpeg gcc curl \
    && rm -rf /var/lib/apt/lists/*

# Always get the latest yt-dlp binary directly from GitHub releases
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp \
    -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp && \
    /usr/local/bin/yt-dlp --version

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN node build.mjs

RUN python3 -m venv .venv && \
    .venv/bin/pip install --upgrade pip && \
    .venv/bin/pip install telethon pytgcalls tgcrypto

EXPOSE 8080
CMD ["node", "dist/index.mjs"]
