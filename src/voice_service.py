#!/usr/bin/env python3
"""
Voice call service using Telethon + pytgcalls 2.x.
Communicates with Node.js bot via stdin/stdout JSON messages.

Client: Telethon (no Pyrogram conversion needed — pytgcalls supports Telethon natively).
pytgcalls 2.x API: play(chat_id, MediaStream(file)) / leave_call(chat_id)
"""

import asyncio
import json
import os
import sys
import logging
from pathlib import Path

logging.basicConfig(level=logging.ERROR)

API_ID   = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
SESSION_STRING = os.environ.get("TELEGRAM_SESSION_STRING", "")

# Global Telethon client and pytgcalls instance
tl_client = None   # TelegramClient (Telethon)
calls     = None   # PyTgCalls

def send(msg: dict):
    print(json.dumps(msg), flush=True)

# ---------------------------------------------------------------------------
# Client / calls helpers
# ---------------------------------------------------------------------------

async def get_tl_client():
    """Return the global Telethon client (must already be connected/started)."""
    return tl_client


async def get_calls():
    """Return (and lazy-init) the PyTgCalls instance bound to the Telethon client."""
    global calls
    if calls is None:
        if tl_client is None:
            raise RuntimeError("No active user session — use /qr to log in")
        from pytgcalls import PyTgCalls
        calls = PyTgCalls(tl_client)
        await calls.start()
    return calls

# ---------------------------------------------------------------------------
# QR login via Telethon (handles DC migration natively)
# ---------------------------------------------------------------------------

async def cmd_qr_login():
    """Start QR login. Emit qr_ready immediately, then wait in background task."""
    global tl_client, calls
    try:
        from telethon import TelegramClient
        from telethon.sessions import StringSession

        # Disconnect old client cleanly if it exists
        if tl_client is not None:
            try:
                await tl_client.disconnect()
            except Exception:
                pass
            tl_client = None
            calls = None

        tl = TelegramClient(StringSession(), API_ID, API_HASH)
        await tl.connect()

        qr = await tl.qr_login()
        send({"ok": True, "event": "qr_ready", "url": qr.url})

        asyncio.create_task(_wait_telethon_qr(tl, qr))

    except Exception as e:
        sys.stderr.write(f"[qr] start error: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        send({"ok": False, "error": f"{type(e).__name__}: {e}"})


async def _wait_telethon_qr(tl, qr):
    """Background task: block until QR is scanned or times out."""
    global tl_client, calls
    try:
        await qr.wait(120)   # Telethon handles DC migration internally

        me = await tl.get_me()

        # Export Telethon StringSession — this is what we save and reuse
        from telethon.sessions import StringSession
        session_str = tl.session.save()   # Telethon session string (starts with "1")

        tl_client = tl            # keep alive — pytgcalls will use it
        calls = None              # reset so get_calls() re-creates with new client

        send({
            "ok": True,
            "event": "qr_logged_in",
            "name": me.first_name or "",
            "phone": getattr(me, "phone", "") or "",
            "session_string": session_str,
        })

    except asyncio.TimeoutError:
        send({"ok": False, "event": "qr_timeout", "error": "QR code expired (120s). Use /qr again."})
        try:
            await tl.disconnect()
        except Exception:
            pass

    except Exception as e:
        name = type(e).__name__
        if "SessionPasswordNeeded" in name or "2FA" in str(e):
            send({"ok": False, "event": "qr_error",
                  "error": "الحساب محمي بكلمة مرور (2FA). يرجى تعطيل 2FA مؤقتاً ثم إعادة المحاولة."})
        else:
            sys.stderr.write(f"[qr] wait error: {name}: {e}\n")
            sys.stderr.flush()
            send({"ok": False, "event": "qr_error", "error": str(e)})
        try:
            await tl.disconnect()
        except Exception:
            pass

# ---------------------------------------------------------------------------
# Session check
# ---------------------------------------------------------------------------

async def cmd_check_session():
    try:
        if tl_client is None or not tl_client.is_connected():
            raise RuntimeError("Not logged in")
        me = await tl_client.get_me()
        send({"ok": True, "event": "session_valid",
              "name": me.first_name or "",
              "phone": getattr(me, "phone", "") or ""})
    except Exception as e:
        send({"ok": False, "event": "session_invalid", "error": str(e)})

# ---------------------------------------------------------------------------
# Voice call commands  (pytgcalls 2.x API)
# ---------------------------------------------------------------------------

async def cmd_join_and_play(chat_id: int, audio_file: str):
    try:
        from pytgcalls.types import MediaStream
        tgc = await get_calls()
        stream = MediaStream(
            audio_file,
            video_flags=MediaStream.Flags.IGNORE,   # audio-only
        )
        await tgc.play(chat_id, stream)
        send({"ok": True, "event": "playing", "chat_id": chat_id})
    except Exception as e:
        err_msg = repr(e)
        sys.stderr.write(f"[play] error: {err_msg}\n")
        sys.stderr.flush()
        send({"ok": False, "error": err_msg, "chat_id": chat_id})


async def cmd_stop(chat_id: int):
    try:
        tgc = await get_calls()
        await tgc.leave_call(chat_id)
        send({"ok": True, "event": "stopped", "chat_id": chat_id})
    except Exception as e:
        sys.stderr.write(f"[stop] error: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        send({"ok": False, "error": str(e)})


async def cmd_pause(chat_id: int):
    try:
        tgc = await get_calls()
        await tgc.pause_stream(chat_id)
        send({"ok": True, "event": "paused", "chat_id": chat_id})
    except Exception as e:
        sys.stderr.write(f"[pause] error: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        send({"ok": False, "error": str(e)})


async def cmd_resume(chat_id: int):
    try:
        tgc = await get_calls()
        await tgc.resume_stream(chat_id)
        send({"ok": True, "event": "resumed", "chat_id": chat_id})
    except Exception as e:
        sys.stderr.write(f"[resume] error: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        send({"ok": False, "error": str(e)})


async def cmd_skip(chat_id: int, audio_file: str):
    try:
        from pytgcalls.types import MediaStream
        tgc = await get_calls()
        stream = MediaStream(
            audio_file,
            video_flags=MediaStream.Flags.IGNORE,
        )
        # In pytgcalls 2.x, playing again on an active call replaces the stream
        await tgc.play(chat_id, stream)
        send({"ok": True, "event": "skipped", "chat_id": chat_id})
    except Exception as e:
        sys.stderr.write(f"[skip] error: {type(e).__name__}: {e}\n")
        sys.stderr.flush()
        send({"ok": False, "error": str(e)})

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

async def main():
    global tl_client, calls

    loop = asyncio.get_event_loop()
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin)

    # Auto-connect if SESSION_STRING is provided
    if SESSION_STRING:
        try:
            from telethon import TelegramClient
            from telethon.sessions import StringSession
            tl = TelegramClient(StringSession(SESSION_STRING), API_ID, API_HASH)
            await tl.start()
            me = await tl.get_me()
            tl_client = tl
            send({"ok": True, "event": "ready", "session_active": True, "name": me.first_name or ""})
        except Exception as e:
            sys.stderr.write(f"[startup] session error: {e}\n")
            sys.stderr.flush()
            send({"ok": True, "event": "ready", "session_active": False, "error": str(e)})
    else:
        send({"ok": True, "event": "ready"})

    while True:
        try:
            line = await reader.readline()
            if not line:
                break
            data = json.loads(line.decode().strip())
            cmd = data.get("cmd")

            if cmd == "qr_login":
                await cmd_qr_login()
            elif cmd == "check_session":
                await cmd_check_session()
            elif cmd == "join_and_play":
                asyncio.create_task(cmd_join_and_play(data["chat_id"], data["audio_file"]))
            elif cmd == "stop":
                asyncio.create_task(cmd_stop(data["chat_id"]))
            elif cmd == "pause":
                asyncio.create_task(cmd_pause(data["chat_id"]))
            elif cmd == "resume":
                asyncio.create_task(cmd_resume(data["chat_id"]))
            elif cmd == "skip":
                asyncio.create_task(cmd_skip(data["chat_id"], data["audio_file"]))
            else:
                send({"ok": False, "error": f"Unknown command: {cmd}"})
        except json.JSONDecodeError:
            pass
        except Exception as e:
            send({"ok": False, "error": str(e)})


if __name__ == "__main__":
    asyncio.run(main())
