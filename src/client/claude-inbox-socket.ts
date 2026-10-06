/**
 * Claude Code native inbox-socket delivery (cross-session messaging, CC ≥ 2.1.224).
 *
 * Every Claude Code session with cross-session messaging binds a Unix inbox
 * socket and exports its path + auth token to child processes as
 * `CLAUDE_CODE_MESSAGING_SOCKET` / `CLAUDE_CODE_MESSAGING_TOKEN`. The MCP
 * adapter is spawned by the session itself, so it inherits both (verified
 * empirically against CC 2.1.231 on Linux).
 *
 * The wire protocol is newline-delimited JSON, documented by Claude Code's own
 * startup log line:
 *
 *   {"type":"auth","token":"<CLAUDE_CODE_MESSAGING_TOKEN>"}
 *   {"type":"user","message":{"role":"user","content":"..."}}
 *
 * A `user` frame injected this way starts a real turn in the live session —
 * even when it is idle — which is strictly more reliable than the
 * `notifications/claude/channel` MCP notification (only read when Claude
 * happens to look at it). The auth token marks the write as coming from the
 * session's own child, so Claude Code delivers it under the own-child rules
 * on every platform, including bypassPermissions sessions.
 */

import { createConnection } from "node:net";

export interface ClaudeInboxSocketOptions {
  socketPath?: string;
  token?: string;
  timeoutMs?: number;
}

/**
 * True when `claude --version` output names a release with cross-session
 * messaging (≥ 2.1.224), i.e. one that does not need the legacy
 * `--dangerously-load-development-channels` flag for push delivery.
 */
export function claudeSupportsInboxSocket(versionOutput: string | null | undefined): boolean {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput ?? "");
  // ponytail: unknown version → assume modern; `oab claude --legacy-channels` forces the old path.
  if (!m) return true;
  const [major, minor, patch] = m.slice(1).map(Number);
  return major * 1e6 + minor * 1e3 + patch >= 2_001_224;
}

/** True when this process inherited a Claude Code inbox socket. */
export function claudeInboxSocketAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.CLAUDE_CODE_MESSAGING_SOCKET);
}

/**
 * Inject `content` as a fresh user turn into the owning Claude Code session.
 * Resolves `true` when both frames were written and the connection closed
 * cleanly; `false` on any failure (missing socket, connect error, timeout) so
 * the caller can fall back to MCP-notification delivery. Never throws.
 */
export function deliverViaClaudeInboxSocket(
  content: string,
  options: ClaudeInboxSocketOptions = {},
): Promise<boolean> {
  const socketPath = options.socketPath ?? process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = options.token ?? process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socketPath) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };

    // ponytail: 3s flat timeout — local UDS either answers instantly or never.
    const timer = setTimeout(() => done(false), options.timeoutMs ?? 3_000);

    const socket = createConnection(socketPath, () => {
      const frames =
        (token ? `${JSON.stringify({ type: "auth", token })}\n` : "") +
        `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
      socket.end(frames, () => done(true));
    });
    socket.on("error", () => done(false));
  });
}
