/**
 * open-agent-bridge extension for pi (@earendil-works/pi-coding-agent ≥ 1.3).
 *
 * Installed as a single file by `oab pi install-extension` (or `oab init
 * --client pi`) into ~/.pi/agent/extensions/ or a project's .pi/extensions/.
 * pi loads .ts directly; there is no build step and no npm dependency.
 *
 * 1. Registers the open-agent-bridge MCP server with direct exposure, so the
 *    model sees list_agents / message_client_session / channel_inbox / reply.
 * 2. Opens this pi process's host inbox socket. The MCP adapter is pi's child:
 *    it writes each incoming channel message there, already wrapped with the
 *    reply template, and this extension starts a turn with it — queued behind
 *    any work in progress (`followUp`), the way Claude Code queues peer messages.
 *    Routing, the identity wall and acks all stay in the adapter.
 */

import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** The slice of pi's ExtensionAPI this file uses (pi passes the real one). */
interface PiExtensionApi {
  registerMcpServer(
    name: string,
    config: { command: string; args?: string[]; env?: Record<string, string>; exposure?: "direct" },
  ): void;
  on(event: "session_start" | "session_shutdown", handler: () => unknown): unknown;
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
  ): void;
}

// Keep in sync with src/client/host-inbox-socket.ts (this file is installed standalone).
function listenHostInbox(hostPid: number, onMessage: (content: string) => void): Promise<() => void> {
  const path = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "open-agent-bridge", `inbox-${hostPid}.sock`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const server = createServer((conn) => {
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

export default function openAgentBridge(pi: PiExtensionApi): void {
  const identity = process.env.AGENT_BRIDGE_IDENTITY;
  pi.registerMcpServer("open-agent-bridge", {
    command: "open-agent-bridge",
    args: ["mcp", "start"],
    exposure: "direct",
    ...(identity ? { env: { AGENT_BRIDGE_IDENTITY: identity } } : {}),
  });

  let close: (() => void) | null = null;
  pi.on("session_start", async () => {
    close?.(); // /reload, /new and /resume fire shutdown → start; never leave two listeners
    close = await listenHostInbox(process.pid, (content) =>
      pi.sendMessage(
        { customType: "open-agent-bridge", content, display: true },
        { triggerTurn: true, deliverAs: "followUp" },
      ),
    );
  });
  pi.on("session_shutdown", () => {
    close?.();
    close = null;
  });
}
