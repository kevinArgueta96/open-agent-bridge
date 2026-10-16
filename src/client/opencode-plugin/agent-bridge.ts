/**
 * open-agent-bridge plugin for OpenCode (2.x, and 1.x from 1.18.29).
 *
 * Auto-loaded from .opencode/plugins/ or ~/.config/opencode/plugins/ — no
 * entry needed in opencode.json(c). Node / Bun built-ins only, no npm install.
 *
 * 1. Registers the open-agent-bridge MCP server (an existing entry wins), so the
 *    model gets list_agents / message_client_session / channel_inbox / reply.
 * 2. Opens a host inbox socket for this OpenCode server process and project.
 *    The MCP adapter is the server's child: it writes each incoming channel
 *    message there, already wrapped with the reply template, and the plugin
 *    queues it as a prompt in the active session. Routing, the identity wall
 *    and acks stay in the adapter, so the plugin registers nothing itself.
 *
 * One default export serves both plugin APIs: OpenCode 2 reads `id` + `setup`,
 * OpenCode 1 (≥ 1.18.29) calls `server()`.
 */

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const MCP_ENTRY = {
  type: "local",
  command: ["open-agent-bridge", "mcp", "start"],
  ...(process.env.AGENT_BRIDGE_IDENTITY ? { environment: { AGENT_BRIDGE_IDENTITY: process.env.AGENT_BRIDGE_IDENTITY } } : {}),
};

// Keep in sync with src/client/host-inbox-socket.ts (this file is installed standalone).
// One OpenCode server can host several projects, so the socket is scoped by directory.
function listenHostInbox(directory: string, onMessage: (content: string) => void): Promise<() => void> {
  const scope = createHash("sha256").update(directory).digest("hex").slice(0, 12);
  const path = join(process.env.XDG_RUNTIME_DIR || tmpdir(), "open-agent-bridge", `inbox-${process.pid}-${scope}.sock`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  rmSync(path, { force: true });
  const seen = new Set<string>();
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
          const frame = JSON.parse(line) as { type?: string; id?: string; message?: { content?: unknown } };
          if (frame.type !== "user" || typeof frame.message?.content !== "string") continue;
          // Two adapters in one agent (an old MCP entry next to the plugin's) or a
          // registry replay write the same message twice; start its turn once.
          if (frame.id) {
            if (seen.has(frame.id)) continue;
            seen.add(frame.id);
            if (seen.size > 500) seen.delete(seen.values().next().value as string);
          }
          onMessage(frame.message.content);
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
      const close = () => {
        server.close();
        rmSync(path, { force: true });
      };
      process.once("exit", close);
      resolve(close);
    });
  });
}

/** The session id an event refers to, whatever its envelope looks like. */
// biome-ignore lint/suspicious/noExplicitAny: event shapes differ between OpenCode versions
function sessionOf(event: any): string | undefined {
  const p = event?.properties ?? event?.data ?? event;
  return p?.sessionID ?? (String(event?.type ?? "").startsWith("session.") ? p?.info?.id ?? p?.id : undefined);
}

// ── OpenCode 2 ────────────────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: OpenCode's plugin context is not a dependency here
async function setup(ctx: any): Promise<() => void> {
  await ctx.mcp.transform((editor: { get(n: string): unknown; set(n: string, c: unknown): void }) => {
    if (!editor.get("open-agent-bridge")) editor.set("open-agent-bridge", MCP_ENTRY);
  });

  let active: string | undefined;
  const controller = new AbortController();
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) active = sessionOf(event) ?? active;
    } catch {
      // stream closed on unload
    }
  })();

  const directory: string = ctx.location.directory;
  let bridgeSession: string | undefined;

  /** The session the user is working in, if it belongs to this project. The
   *  event stream is server-wide, so a session id alone is not enough. */
  async function activeHere(): Promise<string | undefined> {
    if (!active) return undefined;
    try {
      const info = await ctx.session.get({ sessionID: active });
      const where = info?.directory ?? info?.location?.directory;
      return where === undefined || where === directory ? active : undefined;
    } catch {
      return undefined;
    }
  }

  const closeInbox = await listenHostInbox(directory, async (text) => {
    try {
      // With no session open (TUI on its home screen) the adapter has already
      // acked the message, so it must not be dropped: run it in a session of
      // its own, like the Codex bridge's thread, and reuse that one afterwards.
      let sessionID = await activeHere();
      if (!sessionID) {
        bridgeSession ??= (await ctx.session.create({ title: "open-agent-bridge" }))?.id;
        sessionID = bridgeSession;
      }
      // "queue", not the default "steer": never mix a peer's message into the user's running turn.
      if (sessionID) await ctx.session.prompt({ sessionID, text, delivery: "queue" });
    } catch (err) {
      console.error(`[open-agent-bridge] could not deliver a channel message: ${err}`);
    }
  });

  return () => {
    controller.abort();
    closeInbox();
  };
}

// ── OpenCode 1 (≥ 1.18.29) ────────────────────────────────────────────────────

// biome-ignore lint/suspicious/noExplicitAny: OpenCode's plugin input is not a dependency here
async function server(ctx: any) {
  let active: string | undefined;
  await listenHostInbox(ctx.directory ?? process.cwd(), async (text) => {
    let id = active;
    if (!id) {
      const sessions = await ctx.client.session.list().catch(() => []);
      id = Array.isArray(sessions) ? sessions[sessions.length - 1]?.id : undefined;
    }
    if (id) await ctx.client.session.prompt_async({ id, parts: [{ type: "text", text }], noReply: false }).catch(() => {});
  });
  return {
    // biome-ignore lint/suspicious/noExplicitAny: OpenCode's Config type is not a dependency here
    async config(cfg: any) {
      cfg.mcp ??= {};
      cfg.mcp["open-agent-bridge"] ??= { ...MCP_ENTRY, enabled: true };
    },
    async event(input: { event: unknown }) {
      active = sessionOf(input.event) ?? active;
    },
  };
}

export default { id: "open-agent-bridge", setup, server };
