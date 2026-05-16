# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **Build**: esbuild (ESM bundle via build.mjs)

## Telegram Music Bot

A Telegram music bot with Arabic commands, voice call streaming, and QR-based user account login.

### Key files
- `artifacts/api-server/src/bot.ts` — grammY bot, all commands & callbacks
- `artifacts/api-server/src/voice_manager.ts` — Node↔Python IPC bridge (EventEmitter + JSON stdio)
- `artifacts/api-server/src/voice_service.py` — Python daemon (pyrogram + pytgcalls)
- `artifacts/api-server/setup_venv.sh` — Python venv setup script
- `artifacts/api-server/build.mjs` — esbuild + copies voice_service.py to dist/

### Bot commands
- `يوت [أغنية]` — downloads YouTube audio and sends it as a Telegram audio file
- `بحث [أغنية]` — YouTube search showing 5 results as inline keyboard buttons
- `شغل [أغنية]` — downloads and streams audio in the group voice call (requires user account login)
- `وقف` — stops the voice call stream
- `/qr` — generates a QR code for logging in the user account (scan with Telegram app)
- `/status` — shows connected user account name/phone
- `/start` — help message

### Login flow (QR code)
1. User sends `/qr` to the bot
2. Python calls `pyrogram.Client.qr_login()` → returns `tg://login?token=...` URL
3. Node.js fetches QR image from `api.qrserver.com` and sends it as a photo
4. User scans with Telegram: Settings → Devices → Link new device
5. Python's `qr.wait()` resolves → exports session string → sends `qr_logged_in` event
6. Bot notifies user and prints the `TELEGRAM_SESSION_STRING` to save as env var
7. On future startups, set `TELEGRAM_SESSION_STRING` to skip QR login

### Voice call architecture
- `voice_manager.ts` spawns `voice_service.py` as a child process with stdio pipes
- Commands sent as JSON lines on stdin; responses come back on stdout
- `qr_login` returns immediately with QR URL (pendingResolver), then fires async `qr_logged_in` event via `emit("message", msg)`
- LD_LIBRARY_PATH includes gcc libdir for ntgcalls native bindings

### Required environment secrets
- `TELEGRAM_BOT_TOKEN` — from @BotFather
- `TELEGRAM_API_ID` — from my.telegram.org
- `TELEGRAM_API_HASH` — from my.telegram.org
- `TELEGRAM_SESSION_STRING` (optional) — pre-generated Pyrogram session string to skip QR login

### Python venv
- Located at `artifacts/api-server/.venv`
- Packages: pyrogram, py-tgcalls, pytgcalls
- Run `artifacts/api-server/setup_venv.sh` to rebuild

## Key Commands

- `pnpm --filter @workspace/api-server run dev` — run API server (builds then starts)
- `pnpm --filter @workspace/api-server run build` — build only
