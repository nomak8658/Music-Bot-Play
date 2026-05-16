FROM node:22-slim

# System dependencies
RUN apt-get update && apt-get install -y \
    python3 python3-pip python3-venv \
    ffmpeg gcc curl \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp system-wide (in PATH)
RUN pip3 install yt-dlp --break-system-packages

WORKDIR /app

# Install Node.js dependencies
COPY package.json ./
RUN npm install

# Copy source and build
COPY . .
RUN node build.mjs

# Setup Python venv for voice call streaming
RUN python3 -m venv .venv && \
    .venv/bin/pip install --upgrade pip && \
    .venv/bin/pip install pyrogram tgcrypto py-tgcalls

EXPOSE 8080
CMD ["node", "dist/index.mjs"]
