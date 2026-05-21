import { spawn, execFileSync, ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { logger } from "./lib/logger";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

type VoiceMsg = { ok: boolean; event?: string; error?: string; [key: string]: unknown };
type PendingResolve = (msg: VoiceMsg) => void;

const REQUEST_TIMEOUT_MS = 60_000;

class VoiceManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private buffer = "";
  private pendingResolvers: Array<{ resolve: PendingResolve; timer: NodeJS.Timeout }> = [];
  private ready = false;
  private restartTimer: NodeJS.Timeout | null = null;

  start() {
    if (this.proc) return;

    const venvDir = join(__dirname, "..", ".venv");
    const python = existsSync(join(venvDir, "bin", "python3"))
      ? join(venvDir, "bin", "python3")
      : "python3";

    const scriptPath = join(__dirname, "voice_service.py");

    if (!existsSync(scriptPath)) {
      logger.error("voice_service.py not found");
      return;
    }

    // Ensure libstdc++ is in library path for ntgcalls native bindings
    let libPath = "";
    try {
      const p = execFileSync("gcc", ["--print-file-name=libstdc++.so.6"]).toString().trim();
      libPath = p.replace(/\/libstdc\+\+\.so\.6$/, "");
    } catch { /* ignore */ }

    const existing = process.env["LD_LIBRARY_PATH"] ?? "";
    const env = {
      ...process.env,
      LD_LIBRARY_PATH: libPath ? `${libPath}:${existing}` : existing,
      PYTHONUNBUFFERED: "1",
    };

    this.proc = spawn(python, [scriptPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg: VoiceMsg = JSON.parse(line);
          logger.info({ msg }, "VoiceService msg");
          if (msg.event === "ready") {
            this.ready = true;
            this.emit("ready");
          } else {
            const pending = this.pendingResolvers.shift();
            if (pending) {
              clearTimeout(pending.timer);
              pending.resolve(msg);
            } else {
              this.emit("message", msg);
            }
          }
        } catch {
          // ignore parse errors
        }
      }
    });

    this.proc.stderr?.on("data", (d: Buffer) => {
      const txt = d.toString().trim();
      if (txt) logger.warn({ txt }, "VoiceService stderr");
    });

    this.proc.on("exit", (code) => {
      logger.warn({ code }, "VoiceService exited");
      this.ready = false;
      this.proc = null;
      // Reject all pending requests so callers don't hang.
      for (const { resolve, timer } of this.pendingResolvers) {
        clearTimeout(timer);
        resolve({ ok: false, error: "VoiceService crashed" });
      }
      this.pendingResolvers = [];
      // Auto-restart after 5s (resilience)
      if (!this.restartTimer) {
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          logger.info("Auto-restarting VoiceService");
          this.start();
        }, 5000);
      }
    });
  }

  private send(cmd: object) {
    if (!this.proc?.stdin) {
      throw new Error("VoiceService not running");
    }
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  private request(cmd: object): Promise<VoiceMsg> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Remove from queue and resolve with timeout error
        const idx = this.pendingResolvers.findIndex(p => p.resolve === resolve);
        if (idx >= 0) this.pendingResolvers.splice(idx, 1);
        resolve({ ok: false, error: "VoiceService timeout" });
      }, REQUEST_TIMEOUT_MS);
      this.pendingResolvers.push({ resolve, timer });
      try {
        this.send(cmd);
      } catch (err) {
        clearTimeout(timer);
        const idx = this.pendingResolvers.findIndex(p => p.resolve === resolve);
        if (idx >= 0) this.pendingResolvers.splice(idx, 1);
        resolve({ ok: false, error: (err as Error).message });
      }
    });
  }

  isReady() { return this.ready; }

  qrLogin() { return this.request({ cmd: "qr_login" }); }
  checkSession() { return this.request({ cmd: "check_session" }); }
  joinAndPlay(chatId: number, audioFile: string) {
    return this.request({ cmd: "join_and_play", chat_id: chatId, audio_file: audioFile });
  }
  stop(chatId: number) { return this.request({ cmd: "stop", chat_id: chatId }); }
  skip(chatId: number, audioFile: string) {
    return this.request({ cmd: "skip", chat_id: chatId, audio_file: audioFile });
  }
}

export const voiceManager = new VoiceManager();
