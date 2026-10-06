/**
 * MCP Adapter — Bridges the channel system as MCP tools for Claude Code, OpenCode, Codex, and Antigravity
 *
 * AUTO MODE (default):
 *   If no registry is running at localhost:4999, starts one in-process.
 *   Also auto-starts a local agent for the current working directory.
 *   This means `mcp start` is fully self-contained — no manual setup needed.
 *
 * MANUAL MODE:
 *   Run registry + agents separately, then `mcp start` discovers them.
 *
 * Exposed tools (4):
 *   list_agents            — discover connected agents and client sessions
 *   message_client_session — send a channel message to a client session
 *   reply                  — reply to an incoming channel message
 *   channel_inbox          — inspect pending channel conversations
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { detectProjectType } from "../agent/project-detector.js";
import { RegistryClient } from "../client/registry-client.js";
import { ChannelTransport } from "../client/channel-transport.js";
import { ChannelClientRuntime } from "../client/channel-client-runtime.js";
import { ConversationService } from "../client/conversation-service.js";
import { DefaultClientProfileResolver, type ClientBehaviorProfile } from "../client/client-profile-resolver.js";
import { BoundedIdSet } from "../client/bounded-id-set.js";
import { buildInjectionPrompt } from "../client/injection-prompt.js";
import {
  claudeInboxSocketAvailable,
  deliverViaClaudeInboxSocket,
} from "../client/claude-inbox-socket.js";
import { selectConversationsToClear } from "./clear-scope.js";
import { RegistryServer } from "../registry/server.js";
import type { RegistryEntry, AgentMessage, ChannelMessage, AgentRegistration } from "../types/messages.js";

export interface McpAdapterOptions {
  registryUrl?: string;
  /** Auto-start registry if none found (default: true) */
  auto?: boolean;
  /** Project path used for client registration (default: cwd) */
  projectPath?: string;
  /** Channel namespace for this session. Only sessions sharing the same identity
   *  see each other's messages/peers. Defaults to "global". */
  identity?: string;
}

/**
 * Canonical taxonomy of peers reachable through open-agent-bridge.
 *
 * - `claude-code`      Claude Code session (single registry entry per session).
 * - `opencode-code`    OpenCode MCP session — used by the LLM for tool calls.
 *                      Always paired with `opencode-bridge` when the plugin is
 *                      installed.
 * - `opencode-bridge`  OpenCode plugin bridge — injects messages as new turns
 *                      via `session.prompt_async`. Analogous to `codex-bridge`.
 * - `codex-bridge`     Codex daemon that injects messages as new turns into the
 *                      Codex CLI. Always paired with `codex-inner` for the same
 *                      `projectPath`.
 * - `codex-inner`      Inner MCP client running inside a Codex session — used
 *                      by Codex's LLM to call `reply` and to poll `channel_inbox`.
 * - `antigravity-inner` Inner MCP client inside an Antigravity (`agy`) session.
 *                      Antigravity has no bridge daemon — it reaches the channel
 *                      via MCP tools plus its native Stop/SessionStart hooks.
 * - `dashboard-ui`     The local dashboard web UI (never a valid send target).
 * - `unknown`          Catch-all for anything that doesn't match the heuristics.
 */
/** Subset of MCP client capabilities we care about for server→client push.
 *  `sampling` lets the bridge call `createMessage` (autonomous delegation);
 *  `elicitation` lets it inject an interaction into the live agent flow. */
export interface ClientCapabilitiesSnapshot {
  sampling?: unknown;
  elicitation?: unknown;
  roots?: unknown;
  [key: string]: unknown;
}

/** Build the stable agentId for a client session. Encodes (clientName,
 *  projectPath, identity) so distinct `--identity` namespaces in the same
 *  project register as separate agents. Omitting identity == "global". Pure. */
export function buildStableClientAgentId(
  clientName: string,
  projectPath: string,
  identity = "global",
): string {
  const digest = createHash("sha1")
    .update(`${clientName}\n${projectPath}\n${identity}`)
    .digest("hex")
    .slice(0, 12);
  return `client-${clientName}-${digest}`;
}

export type PeerType =
  | "claude-code"
  | "codex-bridge"
  | "codex-inner"
  | "antigravity-inner"
  | "opencode-code"
  | "opencode-bridge"
  | "dashboard-ui"
  | "unknown";

/** Classify a registry entry into one of the well-known peer types so callers
 *  (and the LLM consuming `list_agents` / `channel_inbox` output) can tell at
 *  a glance whether a row is Claude Code, a Codex bridge daemon, or the inner
 *  MCP client of one of those agents.
 *
 *  Heuristic: `clientVersion` is authoritative for the Codex bridge
 *  (`app-server-bridge`); for everything else we read `clientName`. The
 *  dashboard UI is recognized by its stable agentId. Pure function — safe to
 *  import in tests. */
export function getPeerType(entry: RegistryEntry): PeerType {
  if (entry.agentId === "client-dashboard-ui") return "dashboard-ui";
  const clientName = (entry.clientInfo?.clientName ?? "").toLowerCase();
  const clientVersion = entry.clientInfo?.clientVersion ?? "";
  if (clientName === "claude-code" || clientName === "claude") return "claude-code";
  if (clientVersion === "opencode-plugin-bridge") return "opencode-bridge";
  if (clientName === "opencode" || clientName.includes("opencode")) return "opencode-code";
  if (clientVersion === "app-server-bridge") return "codex-bridge";
  if (clientName.includes("codex")) return "codex-inner";
  if (clientName.includes("antigravity") || clientName === "agy") return "antigravity-inner";
  return "unknown";
}

/** Human-friendly label derived from the peer type — used as a `[Codex bridge]`
 *  prefix in the textual rendering of `list_agents` / `channel_inbox`. */
export function getPeerTypeLabel(entry: RegistryEntry): string {
  switch (getPeerType(entry)) {
    case "claude-code":
      return "Claude Code";
    case "opencode-code":
      return "OpenCode";
    case "opencode-bridge":
      return "OpenCode bridge";
    case "codex-bridge":
      return "Codex bridge";
    case "codex-inner":
      return "Codex inner";
    case "antigravity-inner":
      return "Antigravity inner";
    case "dashboard-ui":
      return "Dashboard UI";
    default:
      return entry.clientInfo?.clientName ?? "unknown";
  }
}

/** Infer whether a proactive channel message is asking the recipient to answer.
 *  Explicit tool input still wins; this only handles omitted `expectsResponse`.
 *
 *  Default is **true** (reply expected). Agent-to-agent channel messages are a
 *  conversation contract — the receiver should answer unless the sender
 *  explicitly opted into fire-and-forget. This matches the previous behavior
 *  pre-inference where `?? true` was the literal default in the adapter.
 *
 *  The earlier "look for question marks, confirma, ack…" approach inverted the
 *  default and made plain conversational messages ("hola mundo", "el deploy
 *  terminó") fall into informational/no-reply, leaving the sender hanging. */
export function inferExpectsResponse(message: string): boolean {
  const normalized = message
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  // Only these explicit markers downgrade the message to informational.
  // Anything else is treated as conversational and SHOULD be replied to.
  const noResponsePatterns = [
    /\bno (?:hace falta|necesito|requiero|requiere|respondas|responder|respuesta)\b/,
    /\b(?:sin|no) respuesta\b/,
    /\bno reply\b/,
    /\bno response (?:needed|required)\b/,
    /\bfyi\b/,
    /\bf\.?y\.?i\.?\b/,
    /\bsolo inform(?:o|ativo|acion)\b/,
    /\bjust (?:fyi|info|letting you know)\b/,
    /\bfor your (?:information|info)\b/,
    /\binformational only\b/,
    /\b(?:no need|don'?t need)\s+to (?:reply|respond|answer)\b/,
  ];
  if (noResponsePatterns.some((pattern) => pattern.test(normalized))) return false;

  return true;
}

type AgentBridgeGuideTopic =
  | "overview"
  | "setup"
  | "send"
  | "reply"
  | "acks"
  | "troubleshooting"
  | "all";

function buildAgentBridgeGuide(topic: AgentBridgeGuideTopic): string {
  const sections: Record<Exclude<AgentBridgeGuideTopic, "all">, string> = {
    overview: [
      "# open-agent-bridge MCP guide",
      "",
      "Use this MCP server to send channel messages between Claude Code, OpenCode, Codex, and Antigravity sessions.",
      "",
      "Tools:",
      "- `agent_bridge_guide(topic?)`: read this usage guide.",
      "- `list_agents(includeClients=true)`: discover peers. Client rows include labels such as `[Claude Code]`, `[OpenCode]`, `[Codex inner]`, `[Antigravity inner]`.",
      "- `message_client_session(...)`: proactively send a message to another client session.",
      "- `channel_inbox(pendingOnly=true)`: inspect inbound pending conversations and get `replyWith` values.",
      "- `reply(...)`: respond to an inbound pending message using `replyWith` verbatim.",
      "",
      "A Codex session can register two entries for the same project: an inner MCP client and a bridge daemon; routing auto-redirects inner clients to the bridge. OpenCode sessions auto-create channels with all visible peers on startup. Antigravity (`agy`) registers a single inner MCP client and receives messages through its native Stop/SessionStart hooks.",
    ].join("\n"),
    setup: [
      "# Setup",
      "",
      "Claude Code:",
      "- Configure `.mcp.json` with `open-agent-bridge mcp config --write`.",
      "- Start Claude Code with the open-agent-bridge development channel enabled.",
      "",
      "OpenCode:",
      "- Configure `.opencode/opencode.json` or `~/.config/opencode/opencode.json` with the open-agent-bridge MCP server entry.",
      "- Install the plugin once per project: `open-agent-bridge opencode install-plugin --project <path>`.",
      "- Restart OpenCode; the plugin opens a WS to the registry and delivers messages directly into the active session via prompt_async.",
      "- Without the plugin, messages still arrive as MCP log entries but the LLM does not see them in real time.",
      "",
      "Codex:",
      "- Preferred: `open-agent-bridge codex start --project <path>`.",
      "- Manual: run `open-agent-bridge codex app-bridge --project <path>`, then attach the TUI with `codex --remote ws://127.0.0.1:4500`.",
      "- A plain `codex` session is isolated; the bridge cannot inject automatic turns into it.",
      "",
      "Antigravity (`agy`):",
      "- Run `open-agent-bridge antigravity install-plugin --project <path>` to write the MCP config + Stop/SessionStart hooks, then (re)start `agy` in that workspace.",
      "- Inbound messages are appended to `.agents/ORIGINAL_REQUEST.md` and the Stop hook makes `agy` continue to read its inbox and reply.",
    ].join("\n"),
    send: [
      "# Sending messages",
      "",
      "Workflow:",
      "1. Call `list_agents(includeClients=true)`.",
      "2. Pick a peer by `agentId`, project, or client type.",
      "3. Call `message_client_session(clientId | project, message, expectsResponse?)`.",
      "",
      "`expectsResponse` contract:",
      "- Pass `expectsResponse=true` when you need a reply.",
      "- Pass `expectsResponse=false` for FYI/fire-and-forget messages.",
      "- If omitted, the adapter infers the value from the message text. Questions, `ack`, `confirm`, `revisa`, `valida`, blockers, and A/B/C option prompts infer true. FYI/no-response phrasing infers false.",
      "",
      "Examples:",
      "- Needs reply: `message_client_session(project=\"api\", message=\"Revisa este diff y confirma si hay blocker\", expectsResponse=true)`.",
      "- No reply: `message_client_session(project=\"api\", message=\"FYI: build verde, no response needed\", expectsResponse=false)`.",
    ].join("\n"),
    reply: [
      "# Replying to inbound messages",
      "",
      "Workflow:",
      "1. Call `channel_inbox(pendingOnly=true, includeMessages=true)`.",
      "2. Read the target conversation's `replyWith` block.",
      "3. Call `reply(agentId=replyWith.agentId, conversationId=replyWith.conversationId, replyTo=replyWith.replyTo, message=...)`.",
      "",
      "Do not re-derive or substitute `replyWith.agentId`. For Codex peers it may already be routed to the bridge daemon while preserving `originalFromAgentId` for traceability.",
      "",
      "`reply` is only for answering a pending inbound message. Use `message_client_session` to start or continue proactive work.",
    ].join("\n"),
    acks: [
      "# Delivery states",
      "",
      "- `queued`: registry created the message row.",
      "- `delivered_to_bridge`: recipient bridge/adapter received the WS event.",
      "- `displayed_to_client`: message was submitted to the recipient runtime or pushed to the client.",
      "- `answered`: recipient replied to the original message.",
      "- `failed`: permanent delivery failure.",
      "",
      "`delivered_to_bridge` does not mean the peer LLM read the message. For Codex, wait for `displayed_to_client` or `answered`; if Codex has no remote TUI attached, the bridge eventually marks the message failed with an actionable detail.",
    ].join("\n"),
    troubleshooting: [
      "# Troubleshooting",
      "",
      "- No peers in `list_agents`: start registry/clients and pass `includeClients=true`.",
      "- Message to Codex does not appear in TUI: use `open-agent-bridge codex start` or attach with `codex --remote ws://127.0.0.1:<port>`; plain `codex` is isolated.",
      "- Stuck at `delivered_to_bridge`: bridge received the message but did not submit it to the runtime. Check Codex remote TUI, bridge logs, or long-running turns.",
      "- `channel_inbox(pendingOnly=true)` is empty: message was fire-and-forget, already answered, expired/failed, or not addressed to this session.",
      "- Agent answers when it should not: pass `expectsResponse=false` explicitly and phrase the message as FYI/no-response.",
    ].join("\n"),
  };

  if (topic === "all") {
    return [
      sections.overview,
      sections.setup,
      sections.send,
      sections.reply,
      sections.acks,
      sections.troubleshooting,
    ].join("\n\n---\n\n");
  }
  return sections[topic];
}

function formatAgentsSummary(agents: RegistryEntry[]): string {
  if (agents.length === 0) {
    return "No agents currently connected. Start one with: open-agent-bridge start <project-path>";
  }
  const runnableAgents = agents.filter((a) => a.entryType !== "client" || a.card.skills.length > 0);
  // Exclude internal infrastructure from the visible client list:
  //   - dashboard UI (agentId: client-dashboard-ui)
  //   - the Codex bridge daemon (`app-server-bridge`) — it pairs 1:1 with an
  //     inner client that already represents the same session, and routing to
  //     the bridge is handled automatically by `resolveDeliverableTarget`.
  const clients = agents.filter((a) => {
    if (a.entryType !== "client") return false;
    if (a.card.skills.length !== 0) return false;
    const peerType = getPeerType(a);
    return peerType !== "dashboard-ui" && peerType !== "codex-bridge" && peerType !== "opencode-bridge";
  });

  return [
    `${agents.length} entry(ies) connected via open-agent-bridge:\n`,
    runnableAgents.length > 0 ? "Agents with skills:\n" : "Agents with skills:\n  (none)",
    ...runnableAgents.map((a) => {
      const skills = a.card.skills.map((s) => `    • ${s.id}: ${s.description}`).join("\n");
      return [
        // Use the agentId SUFFIX (unique hash), not the prefix — every client
        // shares `client-{claude,codex,antigravity,dashboard}-...` so slicing from
        // the front would render every row as the same `[client-c]`.
        `Agent: ${a.name}  [${a.agentId.slice(-8)}]`,
        `  Project: ${a.projectPath}`,
        `  Type:    ${a.projectType}${a.entryType === "client" ? " (client — no skills)" : ""}`,
        `  Status:  ${a.healthy ? "healthy" : "unhealthy"}`,
        `  Skills:\n${skills}`,
      ].join("\n");
    }),
    "",
    clients.length > 0 ? "Client sessions via channels:\n" : "Client sessions via channels:\n  (none)",
    ...clients.map((a) => [
      // See note above on `slice(-8)` — using the unique suffix lets the user
      // tell two same-project peers (e.g. `[Claude Code]` and `[Codex inner]`)
      // apart at a glance instead of both rendering as `[client-c]`.
      `[${getPeerTypeLabel(a)}]  ${a.name}  [${a.agentId.slice(-8)}]`,
      `  agentId: ${a.agentId}`,
      `  Project: ${a.projectPath}`,
      `  Client:  ${a.clientInfo?.clientName ?? "unknown"} ${a.clientInfo?.clientVersion ?? ""}`.trimEnd(),
      `  Status:  ${a.healthy ? "healthy" : "unhealthy"}`,
      "  Use:     message_client_session (routing to the bridge is automatic)",
    ].join("\n")),
  ].join("\n");
}

export class McpAgentBridge {
  private server: McpServer;
  private registry: RegistryClient;
  private channelTransport: ChannelTransport;
  private channelRuntime: ChannelClientRuntime;
  private conversationService: ConversationService;
  private readonly profileResolver = new DefaultClientProfileResolver();
  private clientProfile: ClientBehaviorProfile;
  private options: Required<McpAdapterOptions>;
  private clientAgentId: string | null = null;
  private clientActivating = false;
  /** MCP capabilities the connected client declared at initialize. Used to
   *  decide whether server→client push is possible (sampling/elicitation) for
   *  non-Claude clients like Antigravity. Empty until oninitialized runs. */
  private clientCapabilities: ClientCapabilitiesSnapshot = {};
  private embeddedRegistry: RegistryServer | null = null;
  private surfacedInboxMessageIds = new BoundedIdSet(5_000);
  private pendingPreInitMessages: ChannelMessage[] = [];
  private syncInFlight = false;
  /** AgentIds of bridge daemons (`client-codex-bridge-*`) that share
   *  this MCP client's project path. A Codex session registers two entries
   *  — the bridge and the inner MCP client — and the auto-redirect rewrites
   *  outbound `toAgentId` to the bridge. The inner client must still recognize
   *  those rewritten messages as locally addressable so they surface in
   *  `channel_inbox(pendingOnly=true)`. Refreshed on every registry sync. */
  private siblingBridgeAgentIds: Set<string> = new Set();
  /** The project path actually registered with the registry. Initialized to
   *  the constructor default (cwd) and replaced in `setupClientDetection` once
   *  the MCP roots protocol resolves the real path. Used to look up sibling
   *  bridges without mutating `this.options.projectPath`. */
  private resolvedProjectPath: string = process.cwd();
  /** Periodic sync as defense-in-depth: every 5 min the adapter pulls the
   *  registry's snapshot to recover any messages that slipped through the live
   *  WS path (e.g. half-open socket the runtime hasn't yet detected). */
  private periodicSyncTimer: NodeJS.Timeout | null = null;
  /** One-shot delayed sync triggered after a permanent push failure. Bounds the
   *  worst-case "lost message" window to ~15 s instead of waiting for the next
   *  ws.open or scheduled sync. */
  private delayedSyncTimer: NodeJS.Timeout | null = null;

  constructor(options: McpAdapterOptions = {}) {
    this.options = {
      registryUrl: "http://localhost:4999",
      auto: true,
      projectPath: process.cwd(),
      identity: "global",
      ...options,
    };
    // Normalize: an explicit `identity: undefined` in options must not defeat the default.
    if (!this.options.identity) this.options.identity = "global";
    this.registry = new RegistryClient(this.options.registryUrl);
    this.channelTransport = new ChannelTransport({ registryUrl: this.options.registryUrl });
    this.channelRuntime = new ChannelClientRuntime({
      transport: this.channelTransport,
      reconnectDelayMs: 5_000,
      maxReconnectAttempts: 5,
    });
    this.conversationService = new ConversationService(this.channelRuntime);
    // Default to Claude profile until the real client identifies itself
    this.clientProfile = this.profileResolver.resolve({ clientName: "claude-code" });
    this.server = new McpServer(
      { name: "open-agent-bridge", version: "0.1.0" },
      {
        capabilities: { experimental: { "claude/channel": {} } },
        instructions:
          "open-agent-bridge — multi-agent communication hub.\n\n" +
          "Tools:\n" +
          "  • agent_bridge_guide(topic='all') — usage guide for setup, sending, replies, ACK states, and troubleshooting.\n" +
          "  • list_agents(includeClients=true) — discover peers; client-session rows include a peer-type label " +
          "such as `[Claude Code]`, `[OpenCode]`, `[Codex inner]`, or `[Antigravity inner]`.\n" +
          "  • message_client_session(clientId | project, message) — open a new thread to a peer. " +
          "Routing is automatic; for a Codex session pass any agentId from its pair (it registers two — both work).\n" +
          "  • channel_inbox(pendingOnly=true) — list pending conversations; each entry has a `replyWith` block.\n" +
          "  • reply(agentId, conversationId, replyTo, message) — respond to a pending message; " +
          "copy `replyWith` fields verbatim.\n\n" +
          "OpenCode sessions auto-create channels with all visible peers on startup. " +
          "For workflow patterns, peer-type semantics, and troubleshooting, load the `agent-bridge` skill.",
      },
    );
    this.setupChannelRuntime();
  }

  async start(transport: "stdio" | "http" = "stdio", httpPort = 6000): Promise<void> {
    // ── 1. Ensure registry is running ─────────────────────────────────────
    await this.ensureInfrastructure();

    // ── 1b. Register shutdown cleanup ─────────────────────────────────────
    // Deregister this client from the registry so its row disappears
    // immediately (instead of lingering until the heartbeat times out), then
    // stop any embedded registry. Guarded so it runs at most once.
    let shuttingDown = false;
    let ppidWatchdog: NodeJS.Timeout | null = null;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      if (ppidWatchdog) { clearInterval(ppidWatchdog); ppidWatchdog = null; }
      this.clearSyncTimers();
      // deactivateClient stops the heartbeat AND deregisters from the registry,
      // so the client's row disappears at once instead of lingering until the
      // heartbeat times out.
      try { await this.channelRuntime.deactivateClient?.(); } catch { /* ignore */ }
      if (this.embeddedRegistry) {
        try { await this.embeddedRegistry.stop(); } catch { /* ignore */ }
        this.embeddedRegistry = null;
      }
    };
    process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
    process.once("SIGHUP", () => void shutdown().then(() => process.exit(0)));

    // ── 1b-ii. Parent-death watchdog ──────────────────────────────────────
    // When the spawning host (claude / agy / an IDE ACP runtime) dies, the OS
    // reparents us — typically to init (ppid 1) or a subreaper, never back to
    // the original parent. Without this we would keep heartbeating forever and
    // linger as a zombie row in the registry (the stdin/SIGHUP handlers above
    // only fire when the host closes the pipe cleanly, which a crashed or
    // detached host does not). Poll ppid and self-deregister on reparent.
    const initialPpid = process.ppid;
    ppidWatchdog = setInterval(() => {
      const ppid = process.ppid;
      if (ppid !== initialPpid || ppid === 1) {
        console.error(`[MCP] Parent process gone (ppid ${initialPpid} → ${ppid}); deregistering and exiting.`);
        void shutdown().then(() => process.exit(0));
      }
    }, 10_000);
    ppidWatchdog.unref?.();

    // ── 1c. Connect WS to registry for channel events ─────────────────────
    this.channelRuntime.connect();

    // ── 1d. Periodic re-sync (defense-in-depth) ───────────────────────────
    this.startPeriodicSync();

    // ── 2. Register tools ─────────────────────────────────────────────────
    this.registerMetaTools();

    // ── 3. Setup client detection (must be before connect) ─────────────────
    this.setupClientDetection();

    // ── 4. Connect transport ───────────────────────────────────────────────
    if (transport === "stdio") {
      const stdioTransport = new StdioServerTransport();
      // When the parent client (Claude / agy / Codex …) closes the stdio pipe,
      // exit instead of lingering as an orphan that keeps heartbeating and
      // pollutes the registry. Cover both the transport's own close event and
      // a raw stdin EOF as a belt-and-suspenders signal.
      const onPipeClosed = () => void shutdown().then(() => process.exit(0));
      stdioTransport.onclose = onPipeClosed;
      process.stdin.once("end", onPipeClosed);
      process.stdin.once("close", onPipeClosed);
      await this.server.connect(stdioTransport);
      console.error("[MCP] open-agent-bridge ready.");
    } else {
      await this.startHttpTransport(httpPort);
    }
  }

  // ── Channel runtime event wiring ──────────────────────────────────────────

  private setupChannelRuntime(): void {
    this.channelRuntime.on("ws.open", () => {
      console.error("[MCP] WebSocket connected to registry");
      // Refresh local store on every reconnect so channel_inbox stays accurate
      void this.syncRegistryToLocalStore();
    });

    this.channelRuntime.on("ws.close", () => {
      // nothing to clear — runtime manages its own WS state
    });

    this.channelRuntime.on("channel.message", (channelMessage) => {
      if (this.clientAgentId === null && channelMessage.toAgentId) {
        if (this.pendingPreInitMessages.length >= 100) {
          const dropped = this.pendingPreInitMessages.shift();
          console.error(`[MCP] Pre-init buffer full, dropping oldest message: ${dropped?.messageId}`);
        }
        this.pendingPreInitMessages.push(channelMessage);
        return;
      }
      // Broadcast messages (no toAgentId) are accepted by all profiles even with null selfAgentId
      if (
        !this.clientProfile.acceptsChannelMessage(channelMessage, this.clientAgentId, {
          siblingBridgeAgentIds: this.siblingBridgeAgentIds,
          selfIdentity: this.options.identity,
        })
      )
        return;
      this.deliverChannelMessage(channelMessage);
    });

    this.channelRuntime.on("legacy.notify", (notify) => {
      const notification = this.clientProfile.mapLegacyNotify(notify);
      if (!notification) return;
      void this.server.server.notification(notification);
    });

    this.channelRuntime.on("agent.message", (agentMsg) => {
      if (agentMsg.type === "task.request") {
        if (!this.clientAgentId || agentMsg.toAgentId !== this.clientAgentId) return;
        const notification = this.clientProfile.mapTaskRequestMessage(agentMsg as AgentMessage);
        if (!notification) return;
        void this.server.server.notification(notification);
      }
    });
  }

  private deliverChannelMessage(channelMessage: ChannelMessage): void {
    // The live WS handler and the registry sync both land here; without this a
    // reconnect replay during an in-flight delivery surfaces the message twice.
    if (this.surfacedInboxMessageIds.has(channelMessage.messageId)) return;

    const isPassiveInnerClientMirror =
      (this.clientProfile.id === "codex" || this.clientProfile.id === "antigravity") &&
      typeof channelMessage.toAgentId === "string" &&
      this.siblingBridgeAgentIds.has(channelMessage.toAgentId);

    if (!isPassiveInnerClientMirror) {
      void this.postChannelAck({
        conversationId: channelMessage.conversationId,
        messageId: channelMessage.messageId,
        state: "delivered_to_bridge",
        actorId: this.clientAgentId ?? "mcp-adapter",
        actorType: "bridge",
        detail: "Message received by MCP bridge",
      });
    }

    const notification = this.clientProfile.mapChannelMessage(channelMessage);
    if (!notification) return;

    // Antigravity native push: agy declares the `elicitation` capability but not
    // `sampling`, and it ignores `notifications/message`. So instead of waiting
    // for a turn (hook-driven), push the message as an `elicitation/create`
    // request — agy surfaces it as a live interaction even when idle, and its
    // answer is relayed straight back to the channel. Falls back to the
    // notification path if the elicit is declined / times out / unsupported.
    // Claude Code native push: sessions with cross-session messaging (CC ≥
    // 2.1.224) export their inbox socket to child processes, and the adapter
    // is one. Injecting the message as a `user` frame starts a real turn even
    // when the session is idle — strictly more reliable than the
    // notifications/claude/channel path, which Claude only reads when it
    // happens to look. Falls back to the notification path on any failure.
    // Both async branches claim the id up front (released on failure): each
    // duplicate here is a whole extra turn, not just a repeated notification.
    if (this.clientProfile.id === "claude" && claudeInboxSocketAvailable()) {
      this.surfacedInboxMessageIds.add(channelMessage.messageId);
      // Not `mcp__open-agent-bridge__reply`: a plugin install prefixes it as `mcp__plugin_…`.
      const prompt = buildInjectionPrompt(channelMessage, { replyTool: "reply (open-agent-bridge MCP tool)" });
      void deliverViaClaudeInboxSocket(prompt).then((delivered) => {
        if (delivered) {
          if (!isPassiveInnerClientMirror) {
            void this.postChannelAck({
              conversationId: channelMessage.conversationId,
              messageId: channelMessage.messageId,
              state: "displayed_to_client",
              actorId: this.clientAgentId ?? "mcp-adapter",
              actorType: "bridge",
              detail: "Message injected via Claude Code inbox socket",
            });
          }
        } else {
          this.surfacedInboxMessageIds.delete(channelMessage.messageId);
          this.pushNotificationAndAck(notification, channelMessage, isPassiveInnerClientMirror);
        }
      });
      return;
    }

    if (this.clientProfile.id === "antigravity" && this.clientCapabilities.elicitation) {
      this.surfacedInboxMessageIds.add(channelMessage.messageId);
      void this.tryElicitPush(channelMessage).then((delivered) => {
        if (!delivered) {
          this.surfacedInboxMessageIds.delete(channelMessage.messageId);
          this.pushNotificationAndAck(notification, channelMessage, isPassiveInnerClientMirror);
        }
      });
      return;
    }

    this.pushNotificationAndAck(notification, channelMessage, isPassiveInnerClientMirror);
  }

  /** Push a channel message as a log-style MCP notification and, on success,
   *  mark it surfaced + ack `displayed_to_client`. The default delivery path for
   *  clients without a real-time push capability. */
  private pushNotificationAndAck(
    notification: { method: string; params: Record<string, unknown> },
    channelMessage: ChannelMessage,
    isPassiveInnerClientMirror: boolean,
  ): void {
    void this.tryPushNotification(notification, channelMessage).then((success) => {
      if (success) {
        // Mark surfaced ONLY after the push succeeded — otherwise a permanent push
        // failure would silently swallow the message (sync would skip it as "surfaced"
        // and the client would never see it).
        this.surfacedInboxMessageIds.add(channelMessage.messageId);
        if (!isPassiveInnerClientMirror) {
          void this.postChannelAck({
            conversationId: channelMessage.conversationId,
            messageId: channelMessage.messageId,
            state: "displayed_to_client",
            actorId: this.clientAgentId ?? "mcp-adapter",
            actorType: "bridge",
            detail:
              this.clientProfile.id === "claude"
                ? "Pushed via notifications/claude/channel (shown only with the legacy channels flag)"
                : "Message forwarded to client channel",
          });
        }
      }
    });
  }

  /** Push a channel message to an Antigravity client via MCP `elicitation/create`
   *  and relay its answer back to the channel as a reply. Returns true only when
   *  agy accepted and provided a reply (so the caller can mark it surfaced);
   *  false on decline/cancel/timeout/error so the caller falls back. */
  private async tryElicitPush(channelMessage: ChannelMessage): Promise<boolean> {
    const sender = channelMessage.fromAgentName ?? channelMessage.fromAgentId;
    try {
      const result = await this.server.server.elicitInput({
        message:
          `📨 New open-agent-bridge channel message from ${sender}:\n\n` +
          `${channelMessage.content}\n\n` +
          "Type your reply below to send it back through the channel.",
        requestedSchema: {
          type: "object",
          properties: {
            reply: {
              type: "string",
              description: "Your reply to send back to the sender via the channel",
            },
          },
          required: ["reply"],
        },
      });

      if (result.action !== "accept") return false;
      const reply = (result.content as { reply?: string } | undefined)?.reply;
      if (!reply || !reply.trim()) return false;

      await this.conversationService.replyAndAcknowledge({
        agentId: channelMessage.fromAgentId,
        conversationId: channelMessage.conversationId,
        replyTo: channelMessage.messageId,
        kind: "chat",
        message: reply,
        requiresAck: true,
        expectsResponse: false,
        acknowledgementState: "answered",
        acknowledgementDetail: "Reply sent via Antigravity elicitation push",
      });
      return true;
    } catch (err) {
      console.error(`[MCP] elicitation push failed for ${channelMessage.messageId}: ${String(err)}`);
      return false;
    }
  }

  private async tryPushNotification(
    notification: { method: string; params: Record<string, unknown> },
    channelMessage: ChannelMessage,
    maxRetries = 5,
  ): Promise<boolean> {
    // Capped exponential backoff: 250, 500, 1000, 2000, 4000 ms (capped at 5s).
    // Five attempts buys ~7.5s of resilience against transient stdio backpressure
    // without blocking the event loop for too long.
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.server.server.notification(notification);
        return true;
      } catch (err) {
        console.error(
          `[MCP] Notification push failed (attempt ${attempt}/${maxRetries}) for message ${channelMessage.messageId}: ${String(err)}`,
        );
        if (attempt < maxRetries) {
          const delay = Math.min(250 * Math.pow(2, attempt - 1), 5_000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    console.error(
      `[MCP] Notification push permanently failed for message ${channelMessage.messageId}. ` +
        `Will retry via delayed sync; message stays in inbox: ${channelMessage.conversationId}`,
    );
    // Bound the worst-case "lost message" window: schedule a one-shot sync that
    // will pick this message up again because we never marked it surfaced.
    this.scheduleDelayedSync(15_000);
    return false;
  }

  // ── Sync timers ────────────────────────────────────────────────────────────

  private startPeriodicSync(periodMs = 5 * 60_000): void {
    if (this.periodicSyncTimer) return;
    this.periodicSyncTimer = setInterval(() => {
      if (!this.clientAgentId) return; // pre-init: nothing to sync against
      void this.syncRegistryToLocalStore();
    }, periodMs);
  }

  private scheduleDelayedSync(delayMs: number): void {
    if (this.delayedSyncTimer) return; // already scheduled — coalesce bursts
    this.delayedSyncTimer = setTimeout(() => {
      this.delayedSyncTimer = null;
      void this.syncRegistryToLocalStore();
    }, delayMs);
  }

  private clearSyncTimers(): void {
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
    if (this.delayedSyncTimer) {
      clearTimeout(this.delayedSyncTimer);
      this.delayedSyncTimer = null;
    }
  }

  private drainPendingPreInitMessages(): void {
    const pending = this.pendingPreInitMessages;
    this.pendingPreInitMessages = [];
    for (const msg of pending) {
      if (
        !this.clientProfile.acceptsChannelMessage(msg, this.clientAgentId, {
          siblingBridgeAgentIds: this.siblingBridgeAgentIds,
          selfIdentity: this.options.identity,
        })
      )
        continue;
      if (this.surfacedInboxMessageIds.has(msg.messageId)) continue;
      this.deliverChannelMessage(msg);
    }
  }

  /** Repopulate `siblingBridgeAgentIds` with the bridge daemon entries that
   *  share the given project path. Idempotent and best-effort: failure to reach
   *  the registry leaves the previous snapshot in place.
   *
   *  Caller passes `projectPath` explicitly so this method does not depend on
   *  any mutable state in `this.options` — keeps the data flow explicit. */
  private async refreshSiblingBridgeAgentIds(projectPath: string): Promise<void> {
    try {
      const all = await this.registry.listAgents();
      const next = new Set<string>();
      for (const e of all) {
        if (e.entryType !== "client") continue;
        if (e.projectPath !== projectPath) continue;
        if (e.agentId === this.clientAgentId) continue; // exclude self
        const cv = e.clientInfo?.clientVersion ?? "";
        if (cv === "app-server-bridge" || cv === "acp-bridge" || cv === "opencode-plugin-bridge") {
          next.add(e.agentId);
        }
      }
      this.siblingBridgeAgentIds = next;
    } catch (err: unknown) {
      console.error(
        "[MCP] sibling bridge refresh failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Fetch all conversations from the registry HTTP endpoint and seed the local store.
   *  Also replays any unsurfaced messages after WS reconnection.
   *
   *  IMPORTANT: A message is considered "already handled" if the registry has any ack
   *  for it in a terminal state (`displayed_to_client`, `answered`, `failed`). Without
   *  this check, restarting the client would re-surface every prior message because
   *  `surfacedInboxMessageIds` is in-memory and lost across process restarts. */
  private async syncRegistryToLocalStore(): Promise<void> {
    if (this.syncInFlight) return;
    this.syncInFlight = true;
    try {
      // Refresh sibling bridge ids first so the acceptsChannelMessage filter
      // below recognizes auto-redirected messages targeting our sibling bridge.
      // Uses the path that was registered with the registry (set in
      // setupClientDetection after MCP roots resolution).
      await this.refreshSiblingBridgeAgentIds(this.resolvedProjectPath);

      const entries = await this.registry.listChannelConversations();
      const unsurfacedMessages: ChannelMessage[] = [];
      const TERMINAL_ACK_STATES = new Set(["displayed_to_client", "answered", "failed"]);
      for (const entry of entries) {
        const snapshot = await this.registry.getChannelConversation(entry.conversationId);
        if (!snapshot) continue;

        // Replay both messages AND acknowledgements so lastAckState/awaitingReply
        // reflect the registry's authoritative view after restart.
        this.channelRuntime.seedFromSnapshot(snapshot.messages, snapshot.acknowledgements);

        // Build a set of messageIds that the registry already saw reach a terminal
        // state. These should never be re-surfaced as "new" inbox items.
        const handledIds = new Set<string>();
        for (const ack of snapshot.acknowledgements ?? []) {
          if (TERMINAL_ACK_STATES.has(ack.state)) {
            handledIds.add(ack.messageId);
          }
        }

        for (const msg of snapshot.messages) {
          if (msg.fromAgentId === this.clientAgentId) continue;
          if (this.surfacedInboxMessageIds.has(msg.messageId)) continue;
          if (handledIds.has(msg.messageId)) {
            // Mark in-memory too so any concurrent live delivery dedupes correctly.
            this.surfacedInboxMessageIds.add(msg.messageId);
            continue;
          }
          if (
            !this.clientProfile.acceptsChannelMessage(msg, this.clientAgentId, {
              siblingBridgeAgentIds: this.siblingBridgeAgentIds,
              selfIdentity: this.options.identity,
            })
          )
            continue;
          if (msg.expiresAt && msg.expiresAt <= Date.now()) continue;
          unsurfacedMessages.push(msg);
        }
      }
      console.error(`[MCP] Synced ${entries.length} conversation(s) from registry to local store`);
      if (this.clientAgentId && this.clientProfile.deliveryMode === "push") {
        for (const msg of unsurfacedMessages) {
          this.deliverChannelMessage(msg);
        }
        if (unsurfacedMessages.length > 0) {
          console.error(`[MCP] Replayed ${unsurfacedMessages.length} unsurfaced message(s) after sync`);
        }
      }
    } catch (err: unknown) {
      console.error("[MCP] registry sync failed:", err instanceof Error ? err.message : err);
    } finally {
      this.syncInFlight = false;
    }
  }

  private async postChannelAck(ack: {
    conversationId: string;
    messageId: string;
    state: "queued" | "delivered_to_bridge" | "displayed_to_client" | "answered" | "failed";
    actorId: string;
    actorType: "registry" | "bridge" | "client" | "agent";
    detail?: string;
  }): Promise<void> {
    try {
      await this.channelRuntime.acknowledgeMessage({
        conversationId: ack.conversationId,
        messageId: ack.messageId,
        state: ack.state,
        actorId: ack.actorId,
        actorType: ack.actorType,
        detail: ack.detail,
      });
    } catch (err: unknown) {
      console.error("[MCP] channel ack failed:", err instanceof Error ? err.message : err);
    }
  }

  // ── Infrastructure bootstrap ───────────────────────────────────────────────

  private async ensureInfrastructure(): Promise<void> {
    const registryAvailable = await this.registry.isAvailable();

    if (!registryAvailable) {
      if (!this.options.auto) {
        console.error("[MCP] Registry not available. Start with: open-agent-bridge registry start");
        return;
      }

      // Auto-start embedded registry
      console.error("[MCP] No registry found — starting embedded registry on :4999");
      this.embeddedRegistry = new RegistryServer();
      await this.embeddedRegistry.start();
    }
  }

  // ── Client detection ───────────────────────────────────────────────────────

  private setupClientDetection(): void {
    // Access the underlying MCP SDK Server to hook into the initialize handshake
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerServer = (this.server as unknown as { server: any }).server;
    if (!innerServer) return;

    innerServer.oninitialized = async () => {
      try {
        if (this.clientAgentId || this.clientActivating) {
          console.error(`[MCP] Ignoring duplicate oninitialized`);
          return;
        }

        const clientVersion = innerServer.getClientVersion?.();
        if (!clientVersion?.name) return;

        this.clientActivating = true;

        const clientName: string = clientVersion.name;
        const version: string = clientVersion.version ?? "unknown";
        this.clientProfile = this.profileResolver.resolve({ clientName });
        if (this.clientProfile.id === "claude" && !claudeInboxSocketAvailable()) {
          console.error(
            "[MCP] No Claude Code inbox socket (CC < 2.1.224 or cross-session messaging off): " +
              "live push needs `oab claude --legacy-channels`; otherwise messages wait in channel_inbox.",
          );
        }

        // ── Capability probe ──────────────────────────────────────────────
        // Server→client push for non-Claude clients depends on which MCP
        // capabilities the client declared at initialize. Log + persist them so
        // we can confirm whether `agy` supports sampling/elicitation (the native
        // push/auto-delegation vectors). Best-effort; never blocks activation.
        try {
          const caps = innerServer.getClientCapabilities?.() ?? {};
          this.clientCapabilities = caps as ClientCapabilitiesSnapshot;
          const summary = {
            clientName,
            version,
            sampling: Boolean((caps as Record<string, unknown>).sampling),
            elicitation: Boolean((caps as Record<string, unknown>).elicitation),
            roots: Boolean((caps as Record<string, unknown>).roots),
            raw: caps,
          };
          console.error(`[MCP] client capabilities: ${JSON.stringify(summary)}`);
          // Per-client filename so concurrent clients (Claude + agy) don't clobber
          // each other's snapshot in the shared dir.
          const safeName = clientName.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
          writeFileSync(
            join(homedir(), ".gemini", "antigravity-cli", `oab-caps-${safeName}.json`),
            `${JSON.stringify(summary, null, 2)}\n`,
            "utf8",
          );
        } catch (err) {
          console.error(`[MCP] capability probe failed: ${String(err)}`);
        }

        // Resolve real project path from client's workspace roots (MCP roots protocol)
        let realProjectPath = this.options.projectPath;
        let realProjectName = basename(this.options.projectPath);
        const capabilities = innerServer.getClientCapabilities?.();
        if (capabilities?.roots) {
          try {
            const rootsResult = await innerServer.listRoots();
            if (rootsResult.roots?.length > 0) {
              const firstRoot = rootsResult.roots[0];
              if (firstRoot.uri.startsWith("file://")) {
                realProjectPath = decodeURIComponent(new URL(firstRoot.uri).pathname);
                realProjectName = firstRoot.name || basename(realProjectPath);
              }
            }
          } catch {
            // fall back to configured projectPath
          }
        }

        this.clientAgentId = this.buildStableClientAgentId(
          clientName,
          realProjectPath,
          this.options.identity,
        );
        // Persist the resolved project path so downstream lookups (sibling
        // bridge ids, etc.) match what the client actually identified itself
        // with via the MCP roots protocol, not the cwd-derived constructor
        // default. We do NOT mutate `this.options.projectPath` — keeping the
        // constructor argument immutable avoids side-effects in callers that
        // may have captured the original options object.
        this.resolvedProjectPath = realProjectPath;

        // Detect the real project type (node/python/etc.) instead of
        // registering every client session as "unknown".
        let projectType = "unknown";
        try {
          projectType = (await detectProjectType(realProjectPath)).type;
        } catch {
          // Unreadable project dir — keep "unknown".
        }

        const registration = {
          agentId: this.clientAgentId,
          name: realProjectName,
          url: "",
          wsUrl: "",
          port: 0,
          projectPath: realProjectPath,
          projectName: realProjectName,
          projectType,
          card: {
            name: realProjectName,
            description: `AI client: ${clientName} v${version} — ${realProjectName}`,
            url: "",
            version,
            protocolVersion: "0.3.0",
            capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
            defaultInputModes: ["text"],
            defaultOutputModes: ["text"],
            skills: [],
          },
          registeredAt: Date.now(),
          entryType: "client" as const,
          identity: this.options.identity,
          clientInfo: { clientName, clientVersion: version },
        };

        await this.channelRuntime.activateClient(registration);
        await this.syncRegistryToLocalStore();
        this.drainPendingPreInitMessages();
        console.error(`[MCP] Registered client: ${realProjectName} (${clientName} v${version})`);

        if (this.clientProfile.id === "opencode") {
          await this.autoCreateChannels(registration);
        }

        const cleanup = async () => {
          this.clearSyncTimers();
          this.surfacedInboxMessageIds.clear();
          await this.channelRuntime.deactivateClient();
          this.clientAgentId = null;
          if (this.embeddedRegistry) {
            try { await this.embeddedRegistry.stop(); } catch { /* ignore */ }
            this.embeddedRegistry = null;
          }
        };

        process.once("SIGINT", cleanup);
        process.once("SIGTERM", cleanup);
        process.once("beforeExit", cleanup);
      } catch (err) {
        this.clientActivating = false;
        console.error("[MCP] Failed to register client:", err);
      }
    };
  }

  private buildStableClientAgentId(
    clientName: string,
    projectPath: string,
    identity?: string,
  ): string {
    return buildStableClientAgentId(clientName, projectPath, identity);
  }

  private async autoCreateChannels(registration: AgentRegistration): Promise<void> {
    try {
      const all = await this.registry.listAgents();
      const selfId = registration.agentId;
      const peers = all.filter(
        (e) =>
          e.agentId !== selfId &&
          e.agentId !== "client-dashboard-ui",
      );

      if (peers.length === 0) {
        console.error("[MCP] OpenCode auto-channels: no peers found");
        return;
      }

      for (const peer of peers) {
        const conversationId = this.buildDeterministicConversationId(selfId, peer.agentId);
        const existing = this.channelRuntime.getConversation(conversationId);
        if (existing) continue;

        try {
          await this.channelRuntime.sendMessage({
            conversationId,
            toAgentId: peer.agentId,
            kind: "presence",
            content: `${registration.name} (OpenCode) is now connected`,
            expectsResponse: false,
            requiresAck: false,
          });
        } catch (err) {
          console.error(
            `[MCP] OpenCode auto-channel to ${peer.agentId.slice(0, 16)} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      console.error(`[MCP] OpenCode auto-channels: created ${peers.length} channel(s)`);
    } catch (err) {
      console.error(
        "[MCP] OpenCode auto-channel creation failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Generates a deterministic conversation ID for a bilateral session between two agents.
   * The ID is symmetric (same result regardless of which side initiates) and stable
   * across restarts, so both agents can always find their shared conversation thread.
   */
  private buildDeterministicConversationId(agentIdA: string, agentIdB: string): string {
    const sorted = [agentIdA, agentIdB].sort().join("\n");
    const hex = createHash("sha1").update(sorted).digest("hex");
    // Format as UUID v4-shaped string for compatibility
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  // ── Meta-tools ─────────────────────────────────────────────────────────────

  private registerMetaTools(): void {
    this.registerGuideTools();
    this.registerDiscoveryTools();
    this.registerConversationManagementTools();
    this.registerChannelMessagingTools();
  }

  /** agent_bridge_guide */
  private registerGuideTools(): void {
    this.server.registerTool(
      "agent_bridge_guide",
      {
        description:
          "Read the open-agent-bridge MCP usage guide. " +
          "Use this when you need setup instructions, send/reply workflow, `expectsResponse` semantics, delivery ACK meanings, or troubleshooting.",
        inputSchema: {
          topic: z
            .enum(["overview", "setup", "send", "reply", "acks", "troubleshooting", "all"])
            .optional()
            .describe("Guide section to return (default: all)."),
        },
      },
      async ({ topic = "all" }) => ({
        content: [{ type: "text" as const, text: buildAgentBridgeGuide(topic) }],
      }),
    );
  }

  /** list_agents */
  private registerDiscoveryTools(): void {
    this.server.registerTool(
      "list_agents",
      {
        description:
          "List all agents and client sessions connected to open-agent-bridge. " +
          "Returns agentId, project path, health, skills, and client peer labels such as [Claude Code], [Codex inner], [Antigravity inner]. " +
          "WORKFLOW: call this first to discover targets before using message_client_session. " +
          "Pass includeClients=true to see Claude/Codex/Antigravity client sessions; bridge daemons are internal and routing to them is automatic.",
        inputSchema: {
          skill: z.string().optional().describe("Filter agents with this skill (e.g. 'endpoint-find')"),
          project: z.string().optional().describe("Filter by project name or path substring"),
          healthyOnly: z.boolean().optional().describe("Only show healthy agents (default: true)"),
          includeClients: z.boolean().optional().describe("Include Claude/Codex/Antigravity client sessions that have no HTTP skills (default: false). Set true when looking for a session to message."),
        },
      },
      async ({ skill, project, healthyOnly = true, includeClients = false }) => {
        try {
          let agents = await this.registry.listAgents({
            skill,
            project,
            healthy: healthyOnly ? true : undefined,
          });
          // Identity hard wall: client sessions of a different namespace are
          // invisible. Skilled agents / infra (no identity) stay visible to all.
          const selfIdentity = this.options.identity ?? "global";
          agents = agents.filter(
            (a) => a.entryType !== "client" || (a.identity ?? "global") === selfIdentity,
          );
          if (!includeClients) {
            agents = agents.filter((a) => a.entryType !== "client" || a.card.skills.length > 0);
          }
          return { content: [{ type: "text" as const, text: formatAgentsSummary(agents) }] };
        } catch {
          return {
            content: [{ type: "text" as const, text: "Registry not reachable at localhost:4999." }],
            isError: true,
          };
        }
      }
    );
  }

  /** channel_inbox */
  private registerConversationManagementTools(): void {
    this.server.registerTool(
      "channel_inbox",
      {
        description:
          "Check this agent's channel inbox for pending inbound messages from other agents. " +
          "Returns conversations with a 'replyWith' field — pass those exact values to the reply tool. " +
          "WORKFLOW: (1) call channel_inbox to see pending messages, " +
          "(2) read the replyWith field of each pending conversation, " +
          "(3) call reply(replyWith.agentId, replyWith.conversationId, replyWith.replyTo, yourMessage). " +
          "Syncs automatically from the registry before returning so the view is always current.",
        inputSchema: {
          expiredOnly: z.boolean().optional().describe("Show only locally expired conversations awaiting reply"),
          pendingOnly: z.boolean().optional().describe("Show only conversations awaiting reply (default: true). Set false for the GLOBAL view of all tracked conversations."),
          limit: z.coerce.number().optional().describe("Max conversations returned (default: 25). Protects against context saturation when many are pending."),
          includeMessages: z.boolean().optional().describe("Include each conversation's FULL message history (default: false — only previews + replyWith are returned, to keep the inbox light). Set true (ideally with a narrow view) to read full threads."),
        },
      },
      async ({ expiredOnly = false, pendingOnly = true, limit = 25, includeMessages = false }) => {
        try {
          // Always sync from registry so inbox shows current state even when WS was interrupted
          await this.syncRegistryToLocalStore();

          const allConversations = expiredOnly
            ? this.conversationService.listExpiredSnapshots(limit)
            : pendingOnly
              ? this.conversationService.listPendingSnapshots()
              : this.conversationService.listRecentSnapshots(limit);
          // Bound the payload: even with hundreds pending, never flood the agent's
          // context. Newest-first so the most relevant are shown; the rest are
          // summarized as a count with a pointer to channel_clear / global view.
          const totalCount = allConversations.length;
          const conversations = allConversations.slice(0, limit);
          if (conversations.length === 0) {
            return {
              content: [{
                type: "text" as const,
                text: expiredOnly
                  ? "No expired channel conversations for this client."
                  : pendingOnly
                    ? "No pending channel conversations for this client."
                    : "No tracked channel conversations for this client.",
              }],
            };
          }

          // Prefetch the agents list once and build a (projectPath → bridge) index so
          // we can resolve `replyWith.agentId` to the bridge agentId for Codex
          // peers without doing N HTTP lookups inside the conversation loop.
          let bridgeByProject = new Map<string, RegistryEntry>();
          let agentById = new Map<string, RegistryEntry>();
          try {
            const allAgents = await this.registry.listAgents();
            for (const entry of allAgents) {
              agentById.set(entry.agentId, entry);
              const cv = entry.clientInfo?.clientVersion;
              if (cv === "app-server-bridge" || cv === "opencode-plugin-bridge") {
                bridgeByProject.set(entry.projectPath, entry);
              }
            }
          } catch {
            // best-effort — fall through with empty maps; replyWith just keeps the raw fromAgentId
          }
          const resolveReplyAgentId = (rawAgentId: string): string => {
            const entry = agentById.get(rawAgentId);
            if (!entry) return rawAgentId;
            const cv = entry.clientInfo?.clientVersion ?? "";
            const cn = (entry.clientInfo?.clientName ?? "").toLowerCase();
            const isBridge = cv === "app-server-bridge" || cv === "opencode-plugin-bridge";
            const isCodexOrOpenCode = cn.includes("codex") || cn.includes("opencode");
            if (!isCodexOrOpenCode || isBridge) return rawAgentId;
            return bridgeByProject.get(entry.projectPath)?.agentId ?? rawAgentId;
          };

          const payload = conversations.map((snapshot) => {
            // Find the latest inbound pending message (not from self) to surface reply context
            const latestInbound = snapshot.pendingMessages
              .filter((m) => m.fromAgentId !== this.clientAgentId)
              .at(-1);

            const routedReplyAgentId = latestInbound
              ? resolveReplyAgentId(latestInbound.fromAgentId)
              : undefined;

            // Identify the peer on the other side of the conversation — uses the
            // ORIGINAL fromAgentId (typically the inner MCP client for Codex)
            // so the label reflects the agent, not the bridge daemon plumbing.
            const peerEntry = latestInbound ? agentById.get(latestInbound.fromAgentId) : undefined;
            const peerType: PeerType | undefined = peerEntry ? getPeerType(peerEntry) : undefined;
            const peerLabel = peerEntry ? getPeerTypeLabel(peerEntry) : undefined;

            return {
              conversationId: snapshot.conversation.conversationId,
              status: snapshot.status,
              awaitingReply: snapshot.conversation.awaitingReply,
              lastAckState: snapshot.conversation.lastAckState,
              lastUpdatedAt: snapshot.lastUpdatedAt,
              expiresAt: snapshot.lastMessage?.expiresAt,
              lastMessagePreview: snapshot.lastMessage?.content.slice(0, 160),
              // peerType lets the LLM identify who is on the other end (Claude
              // Code / Codex inner / Antigravity inner / etc.) without parsing
              // agentId prefixes manually.
              ...(peerType ? { peerType, peerLabel } : {}),
              // Exact parameters to pass to the reply tool — no guesswork needed.
              // For Codex peers, `agentId` is already the bridge so the message
              // is delivered as a turn prompt. The original sender's fromAgentId is
              // preserved in `originalFromAgentId` for traceability.
              replyWith: latestInbound
                ? {
                    agentId: routedReplyAgentId!,
                    conversationId: snapshot.conversation.conversationId,
                    replyTo: latestInbound.messageId,
                    ...(peerType ? { peerType } : {}),
                    ...(routedReplyAgentId !== latestInbound.fromAgentId
                      ? { originalFromAgentId: latestInbound.fromAgentId }
                      : {}),
                  }
                : undefined,
              pendingMessages: snapshot.pendingMessages.map((message) => ({
                messageId: message.messageId,
                fromAgentId: message.fromAgentId,
                fromAgentName: message.fromAgentName,
                toAgentId: message.toAgentId,
                expiresAt: message.expiresAt,
                content: message.content,
              })),
              messages: includeMessages
                ? snapshot.messages.map((message) => ({
                    messageId: message.messageId,
                    fromAgentId: message.fromAgentId,
                    fromAgentName: message.fromAgentName,
                    toAgentId: message.toAgentId,
                    replyTo: message.replyTo,
                    content: message.content,
                    createdAt: message.createdAt,
                  }))
                : undefined,
            };
          });

          const view = expiredOnly ? "expired" : pendingOnly ? "pending" : "all";
          const truncated = totalCount > conversations.length;
          const result = {
            summary: {
              view,
              total: totalCount,
              shown: conversations.length,
              truncated,
              ...(truncated
                ? {
                    hint:
                      `Showing the ${conversations.length} most recent of ${totalCount}. ` +
                      "Use channel_clear({scope:'answered'|'failed'|'all'}) to clear handled threads so new ones surface, " +
                      "or raise `limit`. Use channel_inbox(pendingOnly=false) for the global view.",
                  }
                : {}),
            },
            conversations: payload,
          };

          return {
            content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );

    // ── channel_clear ──────────────────────────────────────────────────────
    this.server.registerTool(
      "channel_clear",
      {
        description:
          "Clear handled conversations from THIS agent's inbox so a saturated inbox " +
          "never buries new messages. Suppresses them from channel_inbox (reversible " +
          "server-side) and drops them locally. NEVER clears still-unanswered " +
          "(pending) threads in bulk — only via an explicit conversationId. " +
          "Scopes: 'answered' (replied), 'failed' (failed + expired), 'all' (every " +
          "non-pending thread), or a specific conversationId.",
        inputSchema: {
          scope: z
            .string()
            .describe("'answered' | 'failed' | 'all' | a specific conversationId"),
        },
      },
      async ({ scope }) => {
        try {
          await this.syncRegistryToLocalStore();
          const tracked = this.conversationService
            .listRecentSnapshots(1000)
            .map((s) => ({ conversationId: s.conversation.conversationId, status: s.status }));
          const ids = selectConversationsToClear(tracked, scope);

          let cleared = 0;
          for (const id of ids) {
            try {
              await this.registry.suppressChannelConversation(id);
            } catch {
              // best-effort: still drop locally
            }
            try {
              this.conversationService.deleteConversation(id);
            } catch {
              /* ignore */
            }
            cleared++;
          }

          return {
            content: [{
              type: "text" as const,
              text: `Cleared ${cleared} conversation(s) from the inbox (scope: ${scope}).`,
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );
  }

  /** message_client_session, reply */
  private registerChannelMessagingTools(): void {
    this.server.registerTool(
      "message_client_session",
      {
        description:
          "Initiate or continue a channel message thread with a client session (Claude Code, Codex, Antigravity). " +
          "USE THIS when you want to proactively send a message or task to another agent. " +
          "DO NOT USE THIS to reply to a pending inbound message — use the reply tool for that instead. " +
          "\n\nWORKFLOW: (1) call list_agents(includeClients=true) to find the target's agentId, " +
          "(2) call message_client_session(clientId=<agentId>, message=<text>). " +
          "Target resolution order when clientId is not provided: " +
          "(a) conversationId participant lookup, (b) project name/path match; " +
          "when a project has multiple sessions, claude-code > antigravity > codex (override with clientType). " +
          "\n\nDELIVERY SEMANTICS by target type:" +
          "\n  • Claude Code  → message is injected as a new turn via Claude Code's inbox socket (fallback: <channel> push event)." +
          "\n  • OpenCode     → message arrives as a push notification via notifications/opencode/channel." +
          "\n  • Codex        → message is injected as a new turn prompt by the bridge daemon." +
          "\n  • Antigravity  → message is appended to .agents/ORIGINAL_REQUEST.md and surfaced by the Stop/SessionStart hooks." +
          "\n\nRESPONSE SEMANTICS: set expectsResponse=true only when you need a reply; set false for FYI/fire-and-forget. " +
          "If omitted, the adapter infers it from the message text." +
          "\n\nROUTING (you do NOT need to know which agentId is the bridge): if you pass an inner " +
          "Codex MCP-client agentId (e.g. client-codex-mcp-client-*), " +
          "the adapter auto-redirects the message to the bridge for the same project. So you can copy " +
          "the `from_agent` of an inbound <channel> event or `replyWith.agentId` from channel_inbox " +
          "directly — routing is fixed transparently. This avoids the failure mode where a message " +
          "gets stuck at `delivered_to_bridge` because it was sent to a passive inner client.",
        inputSchema: {
          clientId: z.string().optional().describe("Exact agentId of the target client session (from list_agents). Most reliable — use this whenever possible."),
          project: z.string().optional().describe("Project name or path substring to resolve the target session. Use when you don't have the exact agentId."),
          clientType: z.string().optional().describe("Filter by client type when project matches multiple sessions: 'claude-code', 'opencode', 'codex', or 'antigravity'. Ignored when clientId is set."),
          message: z.string().describe("Message text to send to the target session"),
          conversationId: z.string().optional().describe("Continue an existing conversation thread by reusing its ID. Leave blank to start a new thread."),
          replyTo: z.string().optional().describe("messageId to thread this message as a reply to (optional, for in-thread continuations)"),
          taskId: z.string().optional().describe("Optional task ID to associate with this conversation"),
          expectsResponse: z.boolean().optional().describe("Set true if you require a reply, false for fire-and-forget. If omitted, the adapter infers it from the message text."),
          timeoutMs: z.coerce.number().optional().describe("How long to wait for a reply before reporting timeout (ms, default: 300000). Only used when expectsResponse=true."),
        },
      },
      async (input) => this.handleMessageClientSession(input)
    );

    this.server.registerTool(
      "reply",
      {
        description:
          "Reply to a pending inbound channel message from another agent and mark the thread as answered. " +
          "USE THIS when channel_inbox shows a pending message and you want to respond. " +
          "DO NOT USE THIS to initiate a new conversation — use message_client_session for that. " +
          "\n\nWORKFLOW: (1) call channel_inbox(pendingOnly=true), " +
          "(2) read the replyWith field of the conversation, " +
          "(3) call reply(agentId=replyWith.agentId, conversationId=replyWith.conversationId, replyTo=replyWith.replyTo, message=<your response>). " +
          "All three routing fields (agentId, conversationId, replyTo) are REQUIRED — copy them exactly from replyWith. " +
          "After calling this, the conversation is marked 'answered' and the sender receives your reply." +
          "\n\nROUTING: if `agentId` is a Codex inner MCP client (which is what its `reply` tool " +
          "stamps as `fromAgentId` of their replies), the adapter auto-redirects to the project's bridge " +
          "daemon so the agent receives your reply as a turn prompt. You should always copy " +
          "`replyWith.agentId` verbatim — do NOT try to substitute a bridge agentId yourself. " +
          "OpenCode and Claude Code targets receive the reply directly as a push notification.",
        inputSchema: {
          agentId: z.string().describe("The agentId of the sender you are replying to — MUST be replyWith.agentId from channel_inbox"),
          message: z.string().describe("Your reply text"),
          conversationId: z.string().describe("The conversation thread ID — MUST be replyWith.conversationId from channel_inbox"),
          replyTo: z.string().describe("The messageId you are replying to — MUST be replyWith.replyTo from channel_inbox"),
          taskId: z.string().optional().describe("Task ID associated with the conversation (optional)"),
          skillId: z.string().optional().describe("Optional fallback skill when using task invocation"),
        },
      },
      async ({ agentId, message, conversationId, replyTo, taskId, skillId }) => {
        try {
          // Sync store before reply so resolveReplyContext has fresh data
          await this.syncRegistryToLocalStore();

          // Auto-redirect: if `agentId` is a Codex inner MCP client (which is
          // typically what `replyWith.agentId` returns when the inbound message came
          // from that agent), route the reply through the project's bridge
          // so the agent actually receives it as a turn prompt.
          let routedAgentId = agentId;
          try {
            const target = await this.resolveAgent(agentId);
            const deliverable = await this.resolveDeliverableTarget(target);
            routedAgentId = deliverable.agentId;
          } catch {
            // best-effort — keep the original agentId if lookup fails
          }

          const replyResult = await this.conversationService.replyAndAcknowledge({
            agentId: routedAgentId,
            conversationId,
            replyTo,
            taskId,
            kind: "chat",
            message,
            meta: skillId ? { skillId } : undefined,
            requiresAck: true,
            expectsResponse: false,
            acknowledgementState: "answered",
            acknowledgementDetail: "Reply sent from Claude channel",
          });

          const resolvedAgentId =
            replyResult.reply.message.toAgentId ??
            agentId ??
            replyResult.reply.resolvedContext?.toAgentId;

          if (!resolvedAgentId) {
            return {
              content: [{
                type: "text" as const,
                text: "reply needs agentId, conversationId, and replyTo — use the replyWith field from channel_inbox.",
              }],
              isError: true,
            };
          }

          let recipientName = resolvedAgentId;
          try {
            const entry = await this.resolveAgent(resolvedAgentId);
            recipientName = `${entry.name} (${entry.clientInfo?.clientName ?? resolvedAgentId})`;
          } catch { /* resolveAgent is best-effort */ }

          const channelMessage = replyResult.reply.message;
          return {
            content: [{
              type: "text" as const,
              text: [
                `Reply sent to: ${recipientName}`,
                `  toAgentId:      ${resolvedAgentId}`,
                `  conversationId: ${channelMessage.conversationId}`,
                `  messageId:      ${channelMessage.messageId}`,
                `  replyTo:        ${replyTo}`,
              ].join("\n"),
            }],
          };
        } catch (err) {
          return {
            content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }
    );
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Auto-redirect to a bridge daemon when the user-supplied target is a Codex
   *  inner MCP client.
   *
   *  Why: a Codex session registers TWO entries in the registry —
   *    1. the bridge daemon (`client-codex-bridge-*`),
   *    2. the inner MCP client running inside the agent (`client-codex-mcp-client-*`).
   *
   *  The bridge is the primary delivery path: it injects the content as a new turn
   *  prompt into the CLI, which is the only way Codex will react to the message in
   *  real time. The inner client also stores the message locally so the agent can
   *  poll for it via `channel_inbox(pendingOnly=true)` — see `siblingBridgeAgentIds`
   *  and the `acceptsChannelMessage` profiles for how rewritten `toAgentId`s are
   *  recognized by the inner client.
   *
   *  Antigravity (`agy`) registers no bridge daemon, so it never redirects: it
   *  receives messages via its native Stop/SessionStart hooks plus `channel_inbox`.
   *
   *  Returns the original entry unchanged for Claude Code / Antigravity targets and
   *  for entries that are already a bridge. */
  private async resolveDeliverableTarget(target: RegistryEntry): Promise<RegistryEntry> {
    const clientVersion = target.clientInfo?.clientVersion ?? "";
    const clientName = (target.clientInfo?.clientName ?? "").toLowerCase();
    const isBridge =
      clientVersion === "app-server-bridge" || clientVersion === "opencode-plugin-bridge";
    const isCodex = clientName.includes("codex");
    const isOpenCode = clientName === "opencode" || clientName.includes("opencode");

    if ((!isCodex && !isOpenCode) || isBridge) return target;

    try {
      const all = await this.registry.listAgents();
      const bridge = all.find(
        (e) =>
          e.entryType === "client" &&
          e.projectPath === target.projectPath &&
          (e.clientInfo?.clientVersion === "app-server-bridge" ||
            e.clientInfo?.clientVersion === "acp-bridge" ||
            e.clientInfo?.clientVersion === "opencode-plugin-bridge"),
      );
      if (bridge) {
        console.error(
          `[MCP] Auto-redirect ${target.agentId.slice(0, 24)} (${clientName} inner client) ` +
            `→ ${bridge.agentId.slice(0, 24)} (bridge) — bridge injects the turn into the CLI.`,
        );
        return bridge;
      }
    } catch {
      // best-effort — fall through to the original target
    }
    return target;
  }

  private async resolveAgent(agentId: string): Promise<RegistryEntry> {
    try {
      const entry = await this.registry.getAgent(agentId);
      // If it has a URL (real HTTP server), use it directly
      if (entry.url) return entry;
      // No URL — try to find another entry for same project that has a URL
      const all = await this.registry.listAgents();
      const withUrl = all.find((a) => a.url && a.projectPath === entry.projectPath);
      if (withUrl) return withUrl;
      return entry;
    } catch {
      const all = await this.registry.listAgents();
      const isMatch = (a: RegistryEntry) =>
        a.name.toLowerCase() === agentId.toLowerCase() ||
        a.agentId.startsWith(agentId) ||
        a.projectPath.toLowerCase().includes(agentId.toLowerCase());
      // Prefer entries with a URL (real agents with HTTP servers)
      const matchWithUrl = all.find((a) => a.url && isMatch(a));
      if (matchWithUrl) return matchWithUrl;
      // Fall back to any match (including client entries)
      const anyMatch = all.find(isMatch);
      if (!anyMatch) throw new Error(`Agent "${agentId}" not found. Use list_agents to see available agents.`);
      return anyMatch;
    }
  }

  private async resolveClientSession(params: { clientId?: string; project?: string; clientType?: string; conversationId?: string }): Promise<RegistryEntry> {
    const all = await this.registry.listAgents();
    // Exclude infrastructure entries: dashboard UI and bridge daemons are never valid send targets
    // (bridges are preferred internally via getPriority, but the dashboard should never receive channel messages)
    const clients = all.filter(
      (entry) =>
        entry.entryType === "client" &&
        entry.agentId !== "client-dashboard-ui",
    );

    // 1. Direct clientId lookup (most specific — always wins)
    if (params.clientId) {
      const clientId = params.clientId;
      const entry = clients.find((entry) => entry.agentId === clientId || entry.agentId.startsWith(clientId));
      if (entry) return entry;

      // Exact ID not found — client may have restarted with a new ID.
      // Fall back to matching by client name extracted from the agentId prefix (e.g. "codex" from "client-codex-...").
      const namePart = clientId.replace(/^client-/, "").replace(/-[^-]+$/, "").toLowerCase();
      const fallback = clients.find((e) =>
        e.clientInfo?.clientName?.toLowerCase().includes(namePart) ||
        e.agentId.toLowerCase().includes(namePart)
      );
      if (!fallback) {
        throw new Error(`Client session "${params.clientId}" not found. Use list_agents with includeClients=true.`);
      }
      console.error(`[MCP] Client "${params.clientId}" not found; using fallback match: ${fallback.agentId}`);
      return fallback;
    }

    // 2. No clientId/project — try to resolve from an existing conversationId
    if (!params.project && params.conversationId) {
      const messages = this.channelRuntime.listConversationMessages(params.conversationId);
      // Find the other party: a message not from us
      const otherMsg = messages.find((m) => m.fromAgentId !== this.clientAgentId);
      if (otherMsg?.fromAgentId) {
        const match = clients.find((c) => c.agentId === otherMsg.fromAgentId);
        if (match) return match;
      }
      // Or: a message we sent, look at its toAgentId
      const ourMsg = messages.find((m) => m.fromAgentId === this.clientAgentId && m.toAgentId);
      if (ourMsg?.toAgentId) {
        const match = clients.find((c) => c.agentId === ourMsg.toAgentId);
        if (match) return match;
      }
    }

    if (!params.project) {
      throw new Error("Either clientId or project is required. Use list_agents with includeClients=true to see available clients.");
    }

    // 3. Project name/path matching
    const project = params.project.toLowerCase();
    let matches = clients.filter((entry) =>
      entry.projectPath.toLowerCase().includes(project) || entry.projectName.toLowerCase().includes(project)
    );

    if (matches.length === 0) {
      throw new Error(
        `No client session found for project "${params.project}". Use list_agents with includeClients=true.`
      );
    }

    // 4. Optionally filter by clientType (e.g. "claude-code", "codex", "antigravity")
    if (params.clientType) {
      const typeFiltered = matches.filter((e) =>
        e.clientInfo?.clientName?.toLowerCase().includes(params.clientType!.toLowerCase())
      );
      if (typeFiltered.length > 0) matches = typeFiltered;
    }

    // 5. Multiple matches → prefer by priority instead of throwing an error
    if (matches.length > 1) {
      const CLIENT_PRIORITY = ["claude-code", "claude", "opencode", "antigravity", "agy", "codex-cli", "codex"];
      const getPriority = (e: RegistryEntry) => {
        // App-server bridge daemons always win — they inject messages as turns into the
        // running app-server, which is exactly what we want when multiple Codex sessions
        // coexist (e.g. bridge + TUI MCP client both registered for the same project).
        const cv = e.clientInfo?.clientVersion ?? "";
        if (cv === "app-server-bridge" || cv === "opencode-plugin-bridge") return -1;
        const name = e.clientInfo?.clientName?.toLowerCase() ?? "";
        const idx = CLIENT_PRIORITY.findIndex((p) => name.includes(p));
        return idx === -1 ? CLIENT_PRIORITY.length : idx;
      };
      matches = [...matches].sort((a, b) => getPriority(a) - getPriority(b));
      const chosen = matches[0]!;
      const all_ids = matches.map((e) => `${e.agentId.slice(0, 16)} (${e.clientInfo?.clientName ?? "unknown"})`).join(", ");
      console.error(`[MCP] Multiple clients match "${params.project}": [${all_ids}]. Using: ${chosen.agentId} (${chosen.clientInfo?.clientName}). Use clientId or clientType to be explicit.`);
    }

    return matches[0]!;
  }

  private async handleMessageClientSession(params: {
    clientId?: string;
    project?: string;
    clientType?: string;
    message: string;
    conversationId?: string;
    replyTo?: string;
    taskId?: string;
    expectsResponse?: boolean;
    timeoutMs?: number;
  }): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
    try {
      const resolved = await this.resolveClientSession({
        clientId: params.clientId,
        project: params.project,
        clientType: params.clientType,
        conversationId: params.conversationId,
      });
      // Codex inner MCP clients can't act on push notifications; transparently
      // route the message through their bridge daemon instead.
      const client = await this.resolveDeliverableTarget(resolved);
      const expectsResponse = params.expectsResponse ?? inferExpectsResponse(params.message);
      const expiresAt = expectsResponse ? Date.now() + (params.timeoutMs ?? 300_000) : undefined;
      // Use a deterministic conversationId so both sides always share the same thread.
      // This lets the recipient reply without needing to look up the conversationId.
      const fromAgentId = this.clientAgentId ?? "mcp-adapter";
      const deterministicConversationId = this.buildDeterministicConversationId(fromAgentId, client.agentId);
      const resolvedConversationId = params.conversationId ?? deterministicConversationId;

      const snapshot = params.replyTo || params.conversationId
        ? (await this.conversationService.replyAndAcknowledge({
            agentId: client.agentId,
            conversationId: resolvedConversationId,
            replyTo: params.replyTo,
            taskId: params.taskId,
            message: params.message,
            kind: "chat",
            requiresAck: true,
            expectsResponse,
            expiresAt,
            meta: {
              targetClientId: client.agentId,
              targetProject: client.projectPath,
              targetClientName: client.clientInfo?.clientName,
            },
          })).snapshot
        : await this.conversationService.startConversation({
            toAgentId: client.agentId,
            taskId: params.taskId,
            message: params.message,
            kind: "chat",
            expectsResponse,
            requiresAck: true,
            expiresAt,
            conversationId: resolvedConversationId,
            meta: {
              targetClientId: client.agentId,
              targetProject: client.projectPath,
              targetClientName: client.clientInfo?.clientName,
            },
          });
      const channelMessage = snapshot.messages[snapshot.messages.length - 1];

      // Delivery wait strategy is client-specific:
      //
      // • Claude Code / OpenCode → push delivery works reliably via notifications.
      //   Return fast (≤3s) so the client is not blocked when the reply notification arrives.
      // • Codex/Antigravity → `notifications/message` is only a log line; the AI agent does
      //   NOT react to it once the tool call has returned. The only way to surface the reply
      //   is in-band while the tool is still running. So we keep waiting for "answered".
      const isPushClient = this.clientProfile.id === "claude" || this.clientProfile.id === "opencode";

      // Phase 1 – always wait briefly for any delivery confirmation
      const deliveryAck = await this.conversationService.waitForAcknowledgement(
        channelMessage.conversationId,
        channelMessage.messageId,
        { timeoutMs: 3_000, states: ["delivered_to_bridge", "displayed_to_client", "answered", "failed"] },
      );

      // Phase 2 – for non-Claude clients that don't process push notifications, keep
      // waiting for the actual reply so we can return it inline.
      let deliveryState = deliveryAck;
      if (
        !isPushClient &&
        expectsResponse &&
        deliveryAck &&
        deliveryAck !== "answered" &&
        deliveryAck !== "failed"
      ) {
        const replyAck = await this.conversationService.waitForAcknowledgement(
          channelMessage.conversationId,
          channelMessage.messageId,
          {
            timeoutMs: Math.min(params.timeoutMs ?? 120_000, 120_000),
            pollIntervalMs: 500,
            states: ["answered", "failed"],
          },
        );
        if (replyAck) deliveryState = replyAck;
      }

      // If the agent answered, include the reply text inline
      let replyPreview = "";
      if (deliveryState === "answered") {
        const msgs = this.channelRuntime.listConversationMessages(channelMessage.conversationId);
        const reply = msgs.find((m) => m.replyTo === channelMessage.messageId);
        if (reply) replyPreview = `\n  reply:          ${reply.content.slice(0, 500)}`;
      }

      const statusNote =
        deliveryState === "answered"
          ? ""
          : deliveryState === "failed"
            ? "\n  Note: Delivery failed — the target bridge rejected the message."
            : isPushClient && deliveryState
              ? `\n  Note: Message delivered. The reply will arrive as a push notification.\n  To check now: call channel_inbox(pendingOnly=true)`
              : deliveryState
                ? `\n  Note: Message delivered but no reply within timeout.\n  Call channel_inbox(pendingOnly=true) to check for the reply.`
                : `\n  Note: No delivery confirmation yet. The target bridge may be offline.\n  To check: call channel_inbox(pendingOnly=true)`;

      return {
        content: [{
          type: "text" as const,
          text: [
            `Channel message sent to ${client.name}`,
            `  toAgentId:      ${client.agentId}`,
            `  conversationId: ${channelMessage.conversationId}`,
            `  messageId:      ${channelMessage.messageId}`,
            `  deliveryState:  ${deliveryState ?? "pending"}`,
          ].join("\n") + replyPreview + statusNote,
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }

  // ── HTTP transport ─────────────────────────────────────────────────────────

  private async startHttpTransport(port: number): Promise<void> {
    const { default: express } = await import("express");
    const { SSEServerTransport } = await import("@modelcontextprotocol/sdk/server/sse.js");

    const app = express();
    app.use(express.json());

    let transport: InstanceType<typeof SSEServerTransport> | null = null;

    app.get("/mcp", async (_req, res) => {
      transport = new SSEServerTransport("/mcp/message", res);
      await this.server.connect(transport);
    });

    app.post("/mcp/message", async (req, res) => {
      if (!transport) { res.status(400).json({ error: "No SSE connection" }); return; }
      await transport.handlePostMessage(req, res);
    });

    app.get("/", (_req, res) => {
      res.json({
        server: "open-agent-bridge MCP",
        endpoints: { sse: "/mcp", message: "/mcp/message" },
      });
    });

    await new Promise<void>((resolve) => app.listen(port, "localhost", () => resolve()));
    console.error(`[MCP] HTTP server at http://localhost:${port}/mcp`);
  }
}
