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

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  /** Set only on subagent threads. */
  parentThreadId?: string | null;
  source?: unknown;
  /** Seconds since epoch; what the daemon orders threads by. */
  recencyAt?: number | null;
  updatedAt?: number;
}

/** A thread Codex spawned for itself (subagent, review, compaction): nobody is looking at it. */
function isSubagentThread(thread: ThreadSummary): boolean {
  return Boolean(thread.parentThreadId) || (typeof thread.source === "object" && thread.source !== null && "subAgent" in thread.source);
}

const recency = (thread: ThreadSummary) => thread.recencyAt ?? thread.updatedAt ?? 0;

export interface CodexDaemonOptions {
  /** Project directory; the target is a loaded thread whose cwd matches it. */
  cwd: string;
  socketPath?: string | null;
  /** How long to wait for a busy thread to go idle before giving up. */
  idleWaitMs?: number;
  /** How long connecting + finding the thread may take. Default 10 s. */
  discoveryTimeoutMs?: number;
  /** Message being delivered. Every Codex session of a project runs an adapter
   *  with the same agentId and all of them get the message; with this set, only
   *  the first one to claim it starts the turn. */
  messageId?: string;
  /** Where claims are kept. Default: the bridge's runtime dir. */
  claimDir?: string;
}

/** Atomically claim `key` for this process. Returns the claim's path, or null if another adapter holds it. */
function claimDelivery(key: string, dir: string): string | null {
  // ponytail: empty files in the runtime dir (tmpfs, gone at logout); sweep old ones if it ever lives on disk.
  const path = join(dir, `codex-turn-${key.replace(/[^\w-]/g, "_")}`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, "", { flag: "wx" });
    return path;
  } catch {
    return null;
  }
}

/** Thread ids are UUIDv7: the first 48 bits are the creation time in ms. */
function uuidV7Time(id: string): number {
  return Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16);
}

/**
 * True when `codex --version` output names a release whose TUI runs on the
 * shared app-server daemon (≥ 0.162), i.e. one this module can deliver into.
 */
export function codexSupportsDaemon(versionOutput: string | null | undefined): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput ?? "");
  // ponytail: unknown version → assume modern; `oab codex start` covers older ones.
  if (!m) return true;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major * 1e6 + minor * 1e3 + patch >= 162_000;
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
 * no loaded thread for the project, another adapter already claimed the
 * message, the thread stayed busy past `idleWaitMs`, or anything failed — so the caller can
 * leave the message pending and retry later. Never throws.
 */
export function deliverViaCodexDaemon(content: string, options: CodexDaemonOptions): Promise<boolean> {
  const socketPath = options.socketPath === undefined ? codexDaemonSocketPath() : options.socketPath;
  if (!socketPath) return Promise.resolve(false);

  return new Promise((resolve) => {
    const ws = new WebSocket(`ws+unix://${socketPath}:/`);
    const pending = new Map<number, (msg: RpcMessage) => void>();
    /** Latest status per thread, including changes that land mid-discovery. */
    const statusOf = new Map<string, string>();
    let nextId = 0;
    let threadId: string | null = null;
    let started = false;
    let settled = false;
    let claim: string | null | undefined;

    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      // Anything short of an accepted turn frees the message for the next retry.
      if (!ok && claim) rmSync(claim, { force: true });
      clearTimeout(timer);
      clearTimeout(discoveryTimer);
      ws.close();
      resolve(ok);
    };
    // ponytail: one flat budget covers connect + waiting for idle; a thread busy
    // longer than this stays pending for the next registry sync instead of
    // holding a socket open.
    const timer = setTimeout(() => done(false), options.idleWaitMs ?? 5 * 60_000);
    // A daemon that accepts the connection but never answers must not hold the
    // message for the whole idle budget.
    const discoveryTimer = setTimeout(() => threadId || done(false), options.discoveryTimeoutMs ?? 10_000);

    const call = (method: string, params: Record<string, unknown>) =>
      new Promise<RpcMessage>((res) => {
        const id = ++nextId;
        pending.set(id, res);
        ws.send(JSON.stringify({ id, method, params }));
      });

    const startTurn = async () => {
      if (started || !threadId) return;
      started = true;
      // Per thread: a broadcast reaches sessions of other projects under the same message id.
      if (options.messageId) {
        claim = claimDelivery(
          `${options.messageId}-${threadId}`,
          options.claimDir ?? join(process.env.XDG_RUNTIME_DIR || tmpdir(), "open-agent-bridge"),
        );
        if (claim === null) return done(false);
      }
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
      const changed = msg.params?.threadId;
      if (msg.method === "thread/status/changed" && typeof changed === "string" && status?.type) {
        statusOf.set(changed, status.type);
        if (changed === threadId && status.type === "idle") void startTurn();
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
          if (thread?.cwd === options.cwd && !isSubagentThread(thread)) candidates.push({ ...thread, id });
        }
        // The daemon keeps threads loaded after their TUI closes, so the cwd alone
        // is ambiguous: the live one is the thread the user last worked in. A
        // thread's id says when it was created, not when it was last used — a
        // resumed thread keeps its old id — so creation time only breaks ties.
        // ponytail: a thread resumed but not yet used loses to a closed one with
        // later activity until its first turn; the daemon does not report which
        // threads have a TUI attached.
        const thread = candidates.sort((a, b) => recency(b) - recency(a) || uuidV7Time(b.id) - uuidV7Time(a.id))[0];
        if (!thread) return done(false);
        threadId = thread.id;
        if ((statusOf.get(thread.id) ?? thread.status?.type) === "idle") await startTurn();
      } catch {
        done(false);
      }
    });
  });
}
