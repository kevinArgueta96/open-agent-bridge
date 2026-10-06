import { createServer, type Server } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claudeInboxSocketAvailable,
  claudeSupportsInboxSocket,
  deliverViaClaudeInboxSocket,
} from "../client/claude-inbox-socket.js";

// NOTE: the test process may itself run inside a Claude Code session and
// inherit a REAL CLAUDE_CODE_MESSAGING_SOCKET. Every test passes explicit
// options and scrubs the env so we never inject test frames into a live
// session.
const ENV_KEYS = ["CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN"] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function listen(socketPath: string, onData: (chunk: string) => void): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((conn) => {
      conn.setEncoding("utf8");
      conn.on("data", onData);
    });
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

describe("claudeInboxSocketAvailable", () => {
  it("is false without the env var and true with it", () => {
    expect(claudeInboxSocketAvailable()).toBe(false);
    process.env.CLAUDE_CODE_MESSAGING_SOCKET = "/tmp/whatever.sock";
    expect(claudeInboxSocketAvailable()).toBe(true);
  });
});

describe("claudeSupportsInboxSocket", () => {
  it("gates on Claude Code 2.1.224 and assumes modern when unparseable", () => {
    expect(claudeSupportsInboxSocket("2.1.291 (Claude Code)")).toBe(true);
    expect(claudeSupportsInboxSocket("2.1.224 (Claude Code)")).toBe(true);
    expect(claudeSupportsInboxSocket("2.1.223 (Claude Code)")).toBe(false);
    expect(claudeSupportsInboxSocket("2.0.999 (Claude Code)")).toBe(false);
    expect(claudeSupportsInboxSocket("3.0.0 (Claude Code)")).toBe(true);
    expect(claudeSupportsInboxSocket(undefined)).toBe(true);
  });
});

describe("deliverViaClaudeInboxSocket", () => {
  let dir: string;
  let server: Server | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oab-inbox-"));
  });

  afterEach(async () => {
    if (server) await new Promise((r) => server?.close(r));
    server = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes auth frame then user frame as NDJSON and resolves true", async () => {
    const socketPath = join(dir, "inbox.sock");
    let received = "";
    server = await listen(socketPath, (chunk) => {
      received += chunk;
    });

    const ok = await deliverViaClaudeInboxSocket("hello from the bridge", {
      socketPath,
      token: "tok-123",
    });
    expect(ok).toBe(true);

    // Give the server loop a tick to flush the last chunk.
    await new Promise((r) => setTimeout(r, 50));
    const lines = received.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({ type: "auth", token: "tok-123" });
    expect(JSON.parse(lines[1])).toEqual({
      type: "user",
      message: { role: "user", content: "hello from the bridge" },
    });
  });

  it("omits the auth frame when no token is available", async () => {
    const socketPath = join(dir, "inbox.sock");
    let received = "";
    server = await listen(socketPath, (chunk) => {
      received += chunk;
    });

    const ok = await deliverViaClaudeInboxSocket("no-auth message", { socketPath });
    expect(ok).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    const lines = received.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).type).toBe("user");
  });

  it("resolves false when no socket path is configured", async () => {
    await expect(deliverViaClaudeInboxSocket("nope")).resolves.toBe(false);
  });

  it("resolves false when the socket does not exist", async () => {
    const ok = await deliverViaClaudeInboxSocket("nope", {
      socketPath: join(dir, "missing.sock"),
    });
    expect(ok).toBe(false);
  });
});
