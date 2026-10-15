/**
 * Host inbox sockets — native delivery for agents whose "start a turn" API only
 * exists inside their own process: an OpenCode plugin, a pi extension, an
 * Antigravity sidecar.
 *
 * That in-host component listens on a Unix socket named after the agent's pid.
 * The MCP adapter is a child of the same agent, so it finds the socket from
 * `process.ppid` and writes the same NDJSON frames it writes to Claude Code's
 * inbox socket (`{"type":"user","message":{"role":"user","content":...}}`).
 * The adapter keeps routing, the identity wall and acks; the host component
 * only turns a frame into a turn.
 *
 * The directory is 0700 and the socket 0600, so only the same user can write.
 *
 * Standalone copies of `listenHostInbox` live in the OpenCode plugin and the pi
 * extension (both are installed as single files) — keep them in sync.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * `inbox-<pid>.sock`, or `inbox-<pid>-<dirhash>.sock` when one host process
 * serves several projects (OpenCode 2's server runs a plugin instance per
 * directory) — the adapter knows its directory, so it can compute either.
 */
export function hostInboxSocketPath(
  hostPid: number,
  env: NodeJS.ProcessEnv = process.env,
  directory?: string,
): string {
  const scope = directory ? `-${createHash("sha256").update(directory).digest("hex").slice(0, 12)}` : "";
  return join(env.XDG_RUNTIME_DIR || tmpdir(), "open-agent-bridge", `inbox-${hostPid}${scope}.sock`);
}

/** The inbox socket the parent agent's in-host component opened for `directory`, if any. */
export function parentHostInboxSocket(env: NodeJS.ProcessEnv = process.env, directory?: string): string | null {
  for (const path of [
    ...(directory ? [hostInboxSocketPath(process.ppid, env, directory)] : []),
    hostInboxSocketPath(process.ppid, env),
  ]) {
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * Listen on the inbox socket of `hostPid` and call `onMessage` with the content
 * of every `user` frame. Returns a close function that also removes the socket.
 */
export function listenHostInbox(
  hostPid: number,
  onMessage: (content: string) => void,
  env: NodeJS.ProcessEnv = process.env,
): Promise<() => void> {
  const path = hostInboxSocketPath(hostPid, env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true }); // a previous run of the same pid cannot still be listening
  const server: Server = createServer((conn) => {
    let buf = "";
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => {
      buf += chunk;
    });
    conn.on("end", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          const frame = JSON.parse(line) as { type?: string; message?: { content?: unknown } };
          if (frame.type === "user" && typeof frame.message?.content === "string") onMessage(frame.message.content);
        } catch {
          // not a frame — ignore
        }
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      chmodSync(path, 0o600);
      resolve(() => {
        server.close();
        rmSync(path, { force: true });
      });
    });
  });
}
