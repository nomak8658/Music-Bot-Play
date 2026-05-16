FROM node:22-slim

RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv python3-full \
    ffmpeg gcc curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp — try pipx first, fallback to direct binary
RUN pip3 install yt-dlp --break-system-packages 2>/dev/null || \
    (curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod +x /usr/local/bin/yt-dlp)

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN node build.mjs

RUN python3 -m venv .venv && \
    .venv/bin/pip install --upgrade pip && \
    .venv/bin/pip install pyrogram tgcrypto py-tgcalls

EXPOSE 8080
CMD ["node", "dist/index.mjs"]
