/**
 * Codex native delivery through the app-server daemon (codex-cli ≥ 0.162).
 *
 * The interactive `codex` TUI no longer runs its own engine: it attaches to a
 * shared app-server daemon listening on a Unix socket (WebSocket over UDS) at
 * `$CODEX_HOME/app-server-control/app-server-control.sock`. The MCP adapter is
 * one of that daemon's MCP servers (one per thread), so it can open the same
 * socket, find its own thread and start a turn there. The message shows up
 * in the user's live TUI as a new turn and Codex answers it in place, calling
 * the `reply` tool like any other MCP tool — the Codex counterpart of the
 * Claude Code inbox socket (verified against codex-cli 0.162.1).
 *
 * A busy thread is not interrupted: we wait for its `thread/status/changed`
 * to `idle` and take the next turn, the same queueing Claude Code applies.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";

interface RpcMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: unknown;
}

interface ThreadSummary {
  id: string;
  cwd?: string;
  status?: { type?: string };
}

export interface CodexDaemonOptions {
  /** Project directory; the target is a loaded thread whose cwd matches it. */
  cwd: string;
  socketPath?: string | null;
  /** How long to wait for a busy thread to go idle before giving up. */
  idleWaitMs?: number;
  /** When this adapter process started (ms epoch). Default: from process.uptime(). */
  startedAt?: number;
}

/** Thread ids are UUIDv7: the first 48 bits are the creation time in ms. */
function uuidV7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/** The daemon's control socket, or null when no Codex daemon is running. */
export function codexDaemonSocketPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const home = env.CODEX_HOME ?? join(homedir(), ".codex");
  const path = join(home, "app-server-control", "app-server-control.sock");
  return existsSync(path) ? path : null;
}

/**
 * Start a turn with `content` on the live Codex thread for `cwd`. Resolves
 * `true` once the daemon accepted the turn; `false` when there is no daemon,
 * no loaded thread for the project, the thread stayed busy past `idleWaitMs`,
 * or anything failed — so the caller can fall back. Never throws.
 */
export function deliverViaCodexDaemon(content: string, options: CodexDaemonOptions): Promise<boolean> {
  const socketPath = options.socketPath === undefined ? codexDaemonSocketPath() : options.socketPath;
  if (!socketPath) return Promise.resolve(false);

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`);
    const pending = new Map<number, (msg: RpcMessage) => void>();
    let nextId = 0;
    let threadId: string | null = null;
    let started = false;
    let settled = false;

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ws.close();
      resolve(ok);
    };
    // ponytail: one flat budget covers connect + waiting for idle; a thread busy
    // longer than this falls back to the inbox instead of holding a socket open.
    const timer = setTimeout(() => done(false), options.idleWaitMs ?? 5 * 60_000);

    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<RpcMessage>((res) => {
        const id = ++nextId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const startTurn = async () => {
      if (started || !threadId) return;
      started = true;
      const res = await call("turn/start", { threadId, input: [{ type: "text", text: content }] });
      done(!res.error);
    };

    ws.on("message", (raw) => {
      let msg: RpcMessage;
      try {
        msg = JSON.parse(String(raw)) as RpcMessage;
      } catch {
        return;
      }
      if (msg.id !== undefined) {
        pending.get(msg.id)?.(msg);
        pending.delete(msg.id);
        return;
      }
      const status = msg.params?.status as { type?: string } | undefined;
      if (msg.method === "thread/status/changed" && msg.params?.threadId === threadId && status?.type === "idle") {
        void startTurn();
      }
    });
    ws.on("error", () => done(false));
    ws.on("close", () => done(false));
    ws.on("open", async () => {
      try {
        await call("initialize", { clientInfo: { name: "open-agent-bridge", version: "0.1.0" } });
        ws.send(JSON.stringify({ method: "initialized" }));
        // thread/read, not thread/list: a thread with no turns yet is not listed.
        const loaded = ((await call("thread/loaded/list", {})).result?.data as string[]) ?? [];
        const candidates: ThreadSummary[] = [];
        for (const id of loaded) {
          const read = (await call("thread/read", { threadId: id })).result;
          const thread = (read?.thread ?? read) as ThreadSummary | undefined;
          if (thread?.cwd === options.cwd) candidates.push({ ...thread, id });
        }
        // The daemon keeps threads loaded after their TUI closes, so the cwd alone
        // is ambiguous. It starts one MCP adapter per thread right as the thread is
        // created, so ours is the one born closest to this process.
        // ponytail: a resumed old thread spawns a fresh adapter but keeps its old
        // id; that only misroutes when another thread is live in the same project.
        const startedAt = options.startedAt ?? Date.now() - process.uptime() * 1000;
        const thread = candidates.sort(
          (a, b) => Math.abs(uuidV7Time(a.id) - startedAt) - Math.abs(uuidV7Time(b.id) - startedAt),
        )[0];
        if (!thread) return done(false);
        // Adapters of closed TUIs stay alive with the same agentId and would each
        // answer from their dead thread. Only the newest session delivers.
        if (candidates.some((c) => uuidV7Time(c.id) > uuidV7Time(thread.id))) return done(false);
        threadId = thread.id;
        if (thread.status?.type === "idle") await startTurn();
      } catch {
        done(false);
      }
    });
  });
}
