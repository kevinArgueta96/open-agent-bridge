import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { codexDaemonSocketPath, codexSupportsDaemon, deliverViaCodexDaemon } from "../client/codex-daemon-socket.js";

// A fake app-server daemon on a socket we own — never the user's real one.
const T0 = Date.UTC(2026, 9, 15, 21, 0, 0);
/** A UUIDv7-shaped thread id created at `ms`. */
const v7 = (ms: number) => `${ms.toString(16).padStart(12, "0").replace(/^(.{8})(.{4})$/, "$1-$2")}-7000-8000-000000000000`;
const MINE = v7(T0);
const OTHER = v7(T0 - 60_000);
interface FakeDaemon {
  socketPath: string;
  turnStarts: Array<Record<string, unknown>>;
  peer: () => WebSocket | null;
  close: () => Promise<void>;
}

function fakeDaemon(dir: string, threads: Array<{ id: string; cwd: string; status: string }>): Promise<FakeDaemon> {
  const socketPath = join(dir, "d.sock");
  const http: Server = createServer();
  const wss = new WebSocketServer({ server: http });
  const turnStarts: Array<Record<string, unknown>> = [];
  let peer: WebSocket | null = null;
  wss.on("connection", (ws) => {
    peer = ws;
    ws.on("message", (raw) => {
      const msg = JSON.parse(String(raw)) as { id?: number; method: string; params: Record<string, unknown> };
      if (msg.id === undefined) return;
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: msg.id, result }));
      if (msg.method === "initialize") reply({ userAgent: "fake" });
      if (msg.method === "thread/loaded/list") reply({ data: threads.map((t) => t.id) });
      if (msg.method === "thread/read") {
        const t = threads.find((x) => x.id === msg.params.threadId);
        reply({ thread: t && { ...t, status: { type: t.status } } });
      }
      if (msg.method === "turn/start") {
        turnStarts.push(msg.params);
        reply({ turn: { id: "t-1", status: "inProgress" } });
      }
    });
  });
  return new Promise((resolve) =>
    http.listen(socketPath, () =>
      resolve({
        socketPath,
        turnStarts,
        peer: () => peer,
        close: () => new Promise((r) => { wss.close(); http.close(() => r()); }),
      }),
    ),
  );
}

describe("deliverViaCodexDaemon", () => {
  let dir: string;
  let daemon: FakeDaemon | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oab-codex-"));
  });

  afterEach(async () => {
    await daemon?.close();
    daemon = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts a turn on the idle loaded thread for the project", async () => {
    daemon = await fakeDaemon(dir, [
      { id: OTHER, cwd: "/elsewhere", status: "idle" },
      { id: MINE, cwd: "/proj", status: "idle" },
    ]);
    const ok = await deliverViaCodexDaemon("hello codex", { cwd: "/proj", socketPath: daemon.socketPath });
    expect(ok).toBe(true);
    expect(daemon.turnStarts).toEqual([{ threadId: MINE, input: [{ type: "text", text: "hello codex" }] }]);
  });

  it("picks its own thread when an older one from a closed TUI is still loaded in the project", async () => {
    // The daemon keeps threads loaded after their TUI exits; the adapter was
    // spawned for the thread created right before it started.
    daemon = await fakeDaemon(dir, [
      { id: OTHER, cwd: "/proj", status: "idle" },
      { id: MINE, cwd: "/proj", status: "idle" },
    ]);
    const ok = await deliverViaCodexDaemon("x", { cwd: "/proj", socketPath: daemon.socketPath, startedAt: T0 - 500 });
    expect(ok).toBe(true);
    expect(daemon.turnStarts.map((t) => t.threadId)).toEqual([MINE]);
  });

  it("stays quiet when it belongs to an older session than another live one in the project", async () => {
    // A closed TUI's adapter keeps running with the same agentId; it must not
    // inject into its dead thread and answer a second time.
    daemon = await fakeDaemon(dir, [
      { id: OTHER, cwd: "/proj", status: "idle" },
      { id: MINE, cwd: "/proj", status: "idle" },
    ]);
    const ok = await deliverViaCodexDaemon("x", { cwd: "/proj", socketPath: daemon.socketPath, startedAt: T0 - 60_500 });
    expect(ok).toBe(false);
    expect(daemon.turnStarts).toHaveLength(0);
  });

  it("waits for a busy thread to go idle instead of interrupting it", async () => {
    daemon = await fakeDaemon(dir, [{ id: MINE, cwd: "/proj", status: "active" }]);
    const result = deliverViaCodexDaemon("queued", { cwd: "/proj", socketPath: daemon.socketPath });

    await new Promise((r) => setTimeout(r, 100));
    expect(daemon.turnStarts).toHaveLength(0);

    daemon.peer()?.send(
      JSON.stringify({ method: "thread/status/changed", params: { threadId: MINE, status: { type: "idle" } } }),
    );
    await expect(result).resolves.toBe(true);
    expect(daemon.turnStarts).toHaveLength(1);
  });

  it("gives up when the project has no live Codex thread", async () => {
    daemon = await fakeDaemon(dir, [{ id: OTHER, cwd: "/elsewhere", status: "idle" }]);
    await expect(deliverViaCodexDaemon("x", { cwd: "/proj", socketPath: daemon.socketPath })).resolves.toBe(false);
    expect(daemon.turnStarts).toHaveLength(0);
  });

  it("gives up when the busy thread never goes idle in time", async () => {
    daemon = await fakeDaemon(dir, [{ id: MINE, cwd: "/proj", status: "active" }]);
    const ok = await deliverViaCodexDaemon("x", { cwd: "/proj", socketPath: daemon.socketPath, idleWaitMs: 150 });
    expect(ok).toBe(false);
    expect(daemon.turnStarts).toHaveLength(0);
  });

  it("resolves false without a daemon socket", async () => {
    await expect(deliverViaCodexDaemon("x", { cwd: "/proj", socketPath: null })).resolves.toBe(false);
  });
});

describe("codexSupportsDaemon", () => {
  it("gates on codex-cli 0.162 and assumes modern when unparseable", () => {
    expect(codexSupportsDaemon("codex-cli 0.162.1")).toBe(true);
    expect(codexSupportsDaemon("codex-cli 0.162.0")).toBe(true);
    expect(codexSupportsDaemon("codex-cli 0.146.0")).toBe(false);
    expect(codexSupportsDaemon("codex-cli 1.0.0")).toBe(true);
    expect(codexSupportsDaemon(undefined)).toBe(true);
  });
});

describe("codexDaemonSocketPath", () => {
  it("finds the control socket under CODEX_HOME, null when absent", () => {
    const home = mkdtempSync(join(tmpdir(), "oab-codex-home-"));
    try {
      expect(codexDaemonSocketPath({ CODEX_HOME: home })).toBeNull();
      mkdirSync(join(home, "app-server-control"));
      writeFileSync(join(home, "app-server-control", "app-server-control.sock"), "");
      expect(codexDaemonSocketPath({ CODEX_HOME: home })).toBe(
        join(home, "app-server-control", "app-server-control.sock"),
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
