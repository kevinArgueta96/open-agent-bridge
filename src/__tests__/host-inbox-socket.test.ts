import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deliverViaClaudeInboxSocket } from "../client/claude-inbox-socket.js";
import { DefaultClientProfileResolver } from "../client/client-profile-resolver.js";
import { hostInboxSocketPath, listenHostInbox, parentHostInboxSocket } from "../client/host-inbox-socket.js";

// Sockets live under a temp XDG_RUNTIME_DIR, never the real one.
let runtime: string;
let env: NodeJS.ProcessEnv;
let close: (() => void) | null = null;

beforeEach(() => {
  runtime = mkdtempSync(join(tmpdir(), "oab-rt-"));
  env = { XDG_RUNTIME_DIR: runtime };
});

afterEach(() => {
  close?.();
  close = null;
  rmSync(runtime, { recursive: true, force: true });
});

describe("host inbox socket", () => {
  it("turns a frame written by the adapter into one message for the host", async () => {
    const received: string[] = [];
    close = await listenHostInbox(4242, (c) => received.push(c), env);
    const ok = await deliverViaClaudeInboxSocket("hello pi", { socketPath: hostInboxSocketPath(4242, env) });
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(received).toEqual(["hello pi"]);
  });

  it("never forwards an inherited Claude Code token to another agent's socket", async () => {
    const lines: string[] = [];
    const saved = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = "claude-secret";
    try {
      // A raw listener: record every frame, not just user ones.
      close = await listenHostInbox(4243, () => {}, env);
      close();
      const { createServer } = await import("node:net");
      const path = hostInboxSocketPath(4243, env);
      const server = createServer((c) => c.on("data", (d) => lines.push(String(d))));
      await new Promise<void>((r) => server.listen(path, () => r()));
      close = () => server.close();
      await deliverViaClaudeInboxSocket("x", { socketPath: path });
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
      else process.env.CLAUDE_CODE_MESSAGING_TOKEN = saved;
    }
    expect(lines.join("")).not.toContain("claude-secret");
    expect(lines.join("")).toContain('"type":"user"');
  });

  it("is private to the user and found from the adapter's parent pid", async () => {
    close = await listenHostInbox(process.ppid, () => {}, env);
    const path = hostInboxSocketPath(process.ppid, env);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(parentHostInboxSocket(env)).toBe(path);
    close();
    close = null;
    expect(parentHostInboxSocket(env)).toBeNull();
  });
});

describe("client profile for pi", () => {
  it("resolves pi's MCP client to its own profile, not Codex's", () => {
    expect(new DefaultClientProfileResolver().resolve({ clientName: "pi" }).id).toBe("pi");
  });
});
