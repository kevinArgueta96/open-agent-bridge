import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { CodexAppServerClient, type InjectionContext } from "./codex-app-server-client.js";
import { ChannelTransport } from "./channel-transport.js";
import { ChannelClientRuntime } from "./channel-client-runtime.js";
import { BoundedIdSet } from "./bounded-id-set.js";
import { RegistryClient } from "./registry-client.js";
import { buildInjectionPrompt } from "./injection-prompt.js";
import type { ChannelMessage } from "../types/messages.js";

export interface CodexAppServerBridgeOptions {
  registryUrl?: string;
  projectPath?: string;
  /** Channel namespace. Only sessions sharing it see each other. Default: global */
  identity?: string;
  /** Port for the codex app-server process. Default: 4500 */
  appServerPort?: number;
  /** Reasoning effort for channel turns; `ultra` = proactive sub-agent delegation. */
  effort?: string;
}

interface QueuedMessage {
  message: ChannelMessage;
  retries: number;
  enqueuedAt: number;
}

const MAX_QUEUE_SIZE = 10;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5_000;
const QUEUE_STALE_CHECK_MS = 5_000;
const NO_TUI_QUEUE_TIMEOUT_MS = 30_000;
const MAX_APP_SERVER_RESTARTS = 5;
const MAX_CLIENT_RECONNECTS = 5;

/**
 * Full Codex app-server bridge daemon.
 *
 * Start flow:
 *  1. Spawns `codex app-server --listen ws://127.0.0.1:<appServerPort>`
 *  2. Waits for the app-server to be ready (polls /readyz)
 *  3. Connects to the app-server directly via CodexAppServerClient (initialize handshake)
 *  4. Connects to the registry via ChannelClientRuntime
 *  5. On channel.message: injects into Codex via client.injectMessage()
 *  6. On agentMessage from client: sends reply back to registry
 *
 * The Codex TUI connects directly to the app-server:
 *   codex --remote ws://127.0.0.1:<appServerPort>
 */
export class CodexAppServerBridge extends EventEmitter {
  private readonly identity: string;
  private readonly registryUrl: string;
  private readonly projectPath: string;
  private readonly appServerPort: number;

  private readonly client: CodexAppServerClient;
  private readonly channelTransport: ChannelTransport;
  private readonly channelRuntime: ChannelClientRuntime;
  private readonly registry: RegistryClient;

  private appServerProcess: ChildProcess | null = null;
  private clientAgentId: string | null = null;
  private stopped = false;

  /** Queue of messages waiting for Codex to become idle */
  private readonly pendingQueue: QueuedMessage[] = [];

  /** MessageIds that have been (or are being) delivered to the underlying Codex
   *  process. Built from (a) successful injections, and (b) terminal acks from
   *  this same bridge actor when syncing the registry on startup/reconnect.
   *  Used to avoid double-injection on revive/retry/replay. Bounded to keep
   *  memory predictable in long-running daemons. */
  private readonly injectedMessageIds = new BoundedIdSet(5_000);
  private syncInFlight = false;
  /** Periodic re-sync (defense-in-depth): every 5 min the bridge pulls the
   *  registry's snapshot to recover any messages missed via the live WS path
   *  (e.g. half-open socket, lost broadcast). */
  private periodicSyncTimer: NodeJS.Timeout | null = null;
  /** Checks queued messages that cannot be injected because no Codex TUI has
   *  attached to the app-server thread yet. */
  private queueHealthTimer: NodeJS.Timeout | null = null;
  private noTuiWarningTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private appServerRestarts = 0;
  private clientReconnects = 0;

  constructor(options: CodexAppServerBridgeOptions = {}) {
    super();
    this.registryUrl = options.registryUrl ?? "http://localhost:4999";
    this.projectPath = options.projectPath ?? process.cwd();
    this.identity = options.identity ?? process.env["AGENT_BRIDGE_IDENTITY"] ?? "global";
    this.appServerPort = options.appServerPort ?? 4500;

    this.client = new CodexAppServerClient({
      appServerUrl: `ws://127.0.0.1:${this.appServerPort}`,
      cwd: this.projectPath,
      // Channel traffic is answered in a bridge-owned thread, so we declare its
      // permissions explicitly instead of inheriting whatever the TUI negotiated.
      sandbox: "read-only",
      effort: options.effort ?? null,
    });

    this.channelTransport = new ChannelTransport({ registryUrl: this.registryUrl });
    this.channelRuntime = new ChannelClientRuntime({
      transport: this.channelTransport,
      reconnectDelayMs: 5_000,
      maxReconnectAttempts: 10,
    });
    this.registry = new RegistryClient(this.registryUrl);
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get status(): {
    ready: boolean;
    threadId: string | null;
    turnInProgress: boolean;
    appServerWsUrl: string;
    queueSize: number;
  } {
    return {
      ready: this.client.currentThreadId !== null,
      threadId: this.client.currentThreadId,
      turnInProgress: this.client.turnInProgress,
      appServerWsUrl: `ws://127.0.0.1:${this.appServerPort}`,
      queueSize: this.pendingQueue.length,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;

    // 1. Spawn codex app-server
    await this.spawnAppServer();

    // 2. Connect bridge client directly to app-server (initialize handshake)
    await this.client.connect();

    // 3. Wire client events
    this.wireClientEvents();

    // 4. Register as client in registry — activateClient now connects WS and waits for open
    await this.registerWithRegistry();
    this.wireRuntimeEvents();

    // 5. Recover any messages that arrived while this bridge was offline.
    //    Uses the registry's persisted ack ledger as source of truth.
    await this.syncMissedMessages();

    // 6. Periodic re-sync as defense-in-depth.
    this.startPeriodicSync();
    this.startQueueHealthCheck();
    this.scheduleNoTuiWarning();

    const appServerWsUrl = `ws://127.0.0.1:${this.appServerPort}`;
    if (this.client.ownsThread) {
      console.error(`[Bridge] Ready — answering channel messages in thread ${this.client.currentThreadId}.`);
      console.error(`  Attach a TUI any time with: codex --remote ${appServerWsUrl}`);
    } else {
      console.error(`[Bridge] Ready. Start Codex TUI with:`);
      console.error(`  codex --remote ${appServerWsUrl}`);
    }
  }

  private startPeriodicSync(periodMs = 5 * 60_000): void {
    if (this.periodicSyncTimer) return;
    this.periodicSyncTimer = setInterval(() => {
      void this.syncMissedMessages();
    }, periodMs);
  }

  private startQueueHealthCheck(periodMs = QUEUE_STALE_CHECK_MS): void {
    if (this.queueHealthTimer) return;
    this.queueHealthTimer = setInterval(() => {
      void this.failStaleQueuedMessages();
    }, periodMs);
  }

  private scheduleNoTuiWarning(delayMs = 10_000): void {
    // Owning a thread means delivery never depends on a TUI — nothing to warn about.
    if (this.client.ownsThread) return;
    if (this.noTuiWarningTimer) return;
    this.noTuiWarningTimer = setTimeout(() => {
      this.noTuiWarningTimer = null;
      if (this.stopped || this.client.currentThreadId) return;
      console.error(
        `[Bridge] WARN: No Codex TUI attached. Bridge will queue messages until you run:\n` +
          `  codex --remote ws://127.0.0.1:${this.appServerPort}`,
      );
    }, delayMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    // Cancel a turn we started rather than leaving Codex burning tokens on an
    // answer nobody will read.
    if (this.client.turnInProgress) {
      await this.client.interruptTurn();
    }
    if (this.periodicSyncTimer) {
      clearInterval(this.periodicSyncTimer);
      this.periodicSyncTimer = null;
    }
    if (this.queueHealthTimer) {
      clearInterval(this.queueHealthTimer);
      this.queueHealthTimer = null;
    }
    if (this.noTuiWarningTimer) {
      clearTimeout(this.noTuiWarningTimer);
      this.noTuiWarningTimer = null;
    }

    this.client.disconnect();
    if (this.appServerProcess && !this.appServerProcess.killed) {
      this.appServerProcess.kill("SIGTERM");
    }
    if (this.clientAgentId) {
      try {
        await this.channelRuntime.deactivateClient?.();
      } catch { /* ignore */ }
    }
  }

  // ── App-server spawning ─────────────────────────────────────────────────────

  private async spawnAppServer(): Promise<void> {
    const listenUrl = `ws://127.0.0.1:${this.appServerPort}`;
    console.error(`[Bridge] Spawning codex app-server on ${listenUrl}`);

    // The app-server — not the TUI — is what launches Codex's MCP servers, so
    // this is where our identity has to be injected. A Codex session registers
    // two entries (this bridge and the MCP client inside Codex); without this
    // the inner client stayed in `global` while the bridge sat in the requested
    // namespace, splitting the pair across the identity wall.
    const appServerEnv: NodeJS.ProcessEnv = {
      ...process.env,
      AGENT_BRIDGE_PROJECT: this.projectPath,
    };
    if (this.identity && this.identity !== "global") {
      appServerEnv.AGENT_BRIDGE_IDENTITY = this.identity;
    }

    this.appServerProcess = spawn(
      "codex",
      ["app-server", "--enable", "tui_app_server", "--listen", listenUrl],
      {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: this.projectPath,
        env: appServerEnv,
      },
    );

    this.appServerProcess.stdout?.on("data", (d: Buffer) => {
      process.stderr.write(`[app-server] ${d.toString()}`);
    });
    this.appServerProcess.stderr?.on("data", (d: Buffer) => {
      process.stderr.write(`[app-server] ${d.toString()}`);
    });
    this.appServerProcess.on("exit", (code) => {
      if (this.stopped) return;
      console.error(`[Bridge] app-server exited (code ${code ?? "unknown"})`);
      this.scheduleAppServerRestart();
    });

    await this.waitForAppServer(listenUrl);
  }

  /**
   * Reconnect after the WebSocket drops while the app-server is still alive —
   * which happens in practice, e.g. when a TUI attaches. Previously the bridge
   * only logged the disconnect and stayed registered as healthy while being
   * unable to deliver anything.
   *
   * Only handles the socket: if the process itself died, its `exit` handler
   * owns the recovery and respawns, so we stay out of its way.
   */
  private scheduleClientReconnect(): void {
    if (this.stopped || this.restartTimer) return;
    const processAlive =
      this.appServerProcess && !this.appServerProcess.killed && this.appServerProcess.exitCode === null;
    if (!processAlive) return; // the exit handler will respawn it

    if (this.clientReconnects >= MAX_CLIENT_RECONNECTS) {
      console.error(`[Bridge] gave up reconnecting to the app-server after ${this.clientReconnects} attempts`);
      return;
    }
    const attempt = ++this.clientReconnects;
    const delayMs = Math.min(500 * 2 ** (attempt - 1), 10_000);
    console.error(`[Bridge] reconnecting to app-server in ${delayMs}ms (attempt ${attempt}/${MAX_CLIENT_RECONNECTS})`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void (async () => {
        if (this.stopped) return;
        try {
          await this.client.connect();
          this.clientReconnects = 0;
          console.error("[Bridge] reconnected to app-server");
          this.drainQueue();
        } catch (err) {
          console.error(`[Bridge] reconnect failed: ${err instanceof Error ? err.message : err}`);
          this.scheduleClientReconnect();
        }
      })();
    }, delayMs);
  }

  /**
   * Bring the app-server back after an unexpected exit. Without this the bridge
   * stayed alive but permanently unable to deliver: it kept accepting channel
   * messages into its queue with no runtime behind them.
   *
   * Reconnecting re-runs `thread/start`, so the bridge owns a fresh thread —
   * the previous one died with the process anyway.
   */
  private scheduleAppServerRestart(): void {
    if (this.stopped || this.restartTimer) return;
    if (this.appServerRestarts >= MAX_APP_SERVER_RESTARTS) {
      console.error(
        `[Bridge] app-server exited ${this.appServerRestarts} times — giving up. ` +
          `Restart the bridge once Codex is healthy.`,
      );
      return;
    }
    const attempt = ++this.appServerRestarts;
    const delayMs = Math.min(1_000 * 2 ** (attempt - 1), 15_000);
    console.error(`[Bridge] restarting app-server in ${delayMs}ms (attempt ${attempt}/${MAX_APP_SERVER_RESTARTS})`);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void (async () => {
        if (this.stopped) return;
        try {
          this.client.disconnect();
          await this.spawnAppServer();
          await this.client.connect();
          console.error("[Bridge] app-server restarted and reconnected");
          this.drainQueue();
        } catch (err) {
          console.error(`[Bridge] app-server restart failed: ${err instanceof Error ? err.message : err}`);
          this.scheduleAppServerRestart();
        }
      })();
    }, delayMs);
  }

  private async waitForAppServer(wsUrl: string, maxWaitMs = 15_000): Promise<void> {
    const healthUrl = wsUrl.replace("ws://", "http://") + "/readyz";
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1_000) });
        if (res.ok) {
          console.error(`[Bridge] app-server ready at ${healthUrl}`);
          return;
        }
      } catch { /* not ready yet */ }
      await new Promise((r) => setTimeout(r, 300));
    }
    throw new Error(`Codex app-server did not become ready within ${maxWaitMs}ms`);
  }

  // ── Client event wiring ─────────────────────────────────────────────────────

  private wireClientEvents(): void {
    this.client.on("threadDetected", (threadId) => {
      console.error(`[Bridge] Thread detected: ${threadId}`);
      this.drainQueue();
    });

    this.client.on("turnStarted", (turnId) => {
      console.error(`[Bridge] Turn started: ${turnId}`);
    });

    this.client.on("turnCompleted", (turnId) => {
      console.error(`[Bridge] Turn completed: ${turnId}`);
      void this.drainQueue();
    });

    this.client.on("agentMessage", (text, ctx) => {
      if (!ctx) return;
      console.error(`[Bridge] agentMessage captured (${text.length} chars), sending reply`);
      void this.sendReplyToRegistry(text, ctx);
    });

    // The message was already acked displayed_to_client when turn/start went
    // out; without this a rejection leaves the sender waiting forever.
    this.client.on("injectionRejected", (ctx, reason) => {
      void this.channelTransport.postChannelAck({
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        state: "failed",
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail: `Codex app-server rejected turn/start: ${reason}`,
      });
    });

    this.client.on("disconnected", () => {
      console.error(`[Bridge] App-server client disconnected`);
      this.scheduleClientReconnect();
    });
  }

  // ── Registry client setup ───────────────────────────────────────────────────

  private async registerWithRegistry(): Promise<void> {
    const projectName = basename(this.projectPath);
    this.clientAgentId = this.buildClientAgentId();

    const registration = {
      agentId: this.clientAgentId,
      name: projectName,
      url: "",
      wsUrl: "",
      port: 0,
      projectPath: this.projectPath,
      projectName,
      projectType: "unknown",
      card: {
        name: projectName,
        description: `Codex app-server bridge — ${projectName}`,
        url: "",
        version: "0.1.0",
        protocolVersion: "0.3.0",
        capabilities: {
          streaming: false,
          pushNotifications: false,
          stateTransitionHistory: false,
        },
        defaultInputModes: ["text"],
        defaultOutputModes: ["text"],
        skills: [],
      },
      registeredAt: Date.now(),
      entryType: "client" as const,
      identity: this.identity,
      clientInfo: { clientName: "codex", clientVersion: "app-server-bridge" },
    };

    await this.channelRuntime.activateClient(registration);
    console.error(`[Bridge] Registered with registry as ${this.clientAgentId}`);
  }

  private buildClientAgentId(): string {
    const hash = createHash("sha1")
      .update(`codex-app-bridge\n${this.projectPath}\n${this.identity}`)
      .digest("hex")
      .slice(0, 12);
    return `client-codex-bridge-${hash}`;
  }

  // ── Runtime event wiring ───────────────────────────────────────────────────

  private wireRuntimeEvents(): void {
    this.channelRuntime.on("ws.open", () => {
      console.error("[Bridge] WebSocket connected to registry");
      // Re-identify so the registry maps this WS to our agentId for targeted delivery.
      this.channelRuntime.identify();
      // Recover any messages that may have arrived while the WS was disconnected.
      void this.syncMissedMessages();
    });

    this.channelRuntime.on("channel.message", (message) => {
      if (message.toAgentId && message.toAgentId !== this.clientAgentId) return;
      if (message.fromAgentId === this.clientAgentId) return;

      // Dedup: the same channel.message can arrive multiple times — e.g. when the
      // sender retries `POST /channel/messages`, when a conversation is revived,
      // or when a sync replays a snapshot that overlaps with live broadcasts.
      if (this.injectedMessageIds.has(message.messageId)) {
        console.error(
          `[Bridge] Skipping already-injected ${message.messageId} (conv: ${message.conversationId})`,
        );
        return;
      }

      console.error(
        `[Bridge] Channel message received from ${message.fromAgentId} (conv: ${message.conversationId})`,
      );
      void this.channelTransport.postChannelAck({
        conversationId: message.conversationId,
        messageId: message.messageId,
        state: "delivered_to_bridge",
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail: "Codex app-server bridge received channel message",
      });
      this.enqueueOrInject(message);
    });
  }

  // ── Registry sync ───────────────────────────────────────────────────────────

  /** Replay any messages from the registry that this bridge hasn't yet displayed.
   *
   *  We treat the registry's persisted ack ledger as the source of truth for
   *  "did this bridge already submit this message to Codex?". A message is
   *  considered handled only after this bridge records `displayed_to_client`,
   *  `answered`, or `failed`. `delivered_to_bridge` is intentionally not
   *  terminal: it only means the daemon saw the channel message, and those are
   *  exactly the messages sync must recover if injection was interrupted. */
  private async syncMissedMessages(): Promise<void> {
    if (this.syncInFlight) return;
    if (!this.clientAgentId) return;
    this.syncInFlight = true;
    try {
      const entries = await this.registry.listChannelConversations();
      let replayed = 0;
      for (const entry of entries) {
        const snapshot = await this.registry.getChannelConversation(entry.conversationId);
        if (!snapshot) continue;

        // Build the set of messageIds that this bridge actor has already handled.
        for (const ack of snapshot.acknowledgements ?? []) {
          if (
            ack.actorId === this.clientAgentId &&
            (ack.state === "displayed_to_client" ||
              ack.state === "answered" ||
              ack.state === "failed")
          ) {
            this.injectedMessageIds.add(ack.messageId);
          }
        }

        // Replay messages that target us (or are broadcast) and haven't been handled.
        for (const msg of snapshot.messages) {
          if (msg.fromAgentId === this.clientAgentId) continue;
          if (msg.toAgentId && msg.toAgentId !== this.clientAgentId) continue;
          if (this.injectedMessageIds.has(msg.messageId)) continue;
          if (msg.expiresAt && msg.expiresAt <= Date.now()) continue;
          console.error(
            `[Bridge] Replaying missed message ${msg.messageId} from ${msg.fromAgentId} (conv: ${msg.conversationId})`,
          );
          this.enqueueOrInject(msg);
          replayed++;
        }
      }
      if (replayed > 0) {
        console.error(`[Bridge] Sync replayed ${replayed} missed message(s) from registry`);
      }
    } catch (err) {
      console.error(
        `[Bridge] Registry sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.syncInFlight = false;
    }
  }

  // ── Message injection ───────────────────────────────────────────────────────

  private enqueueOrInject(message: ChannelMessage): void {
    if (this.pendingQueue.some((item) => item.message.messageId === message.messageId)) {
      console.error(`[Bridge] Skipping already-queued ${message.messageId}`);
      return;
    }
    if (!this.client.turnInProgress && this.client.currentThreadId) {
      this.injectNow(message);
    } else {
      if (this.pendingQueue.length >= MAX_QUEUE_SIZE) {
        const dropped = this.pendingQueue.shift();
        console.error(`[Bridge] Queue full, dropping oldest: ${dropped?.message.messageId}`);
      }
      this.pendingQueue.push({ message, retries: 0, enqueuedAt: Date.now() });
      console.error(`[Bridge] Queued message (queue size: ${this.pendingQueue.length})`);
    }
  }

  private injectNow(message: ChannelMessage, retries = 0): void {
    const ctx: InjectionContext = {
      conversationId: message.conversationId,
      messageId: message.messageId,
      fromAgentId: message.fromAgentId,
      expectsResponse: message.expectsResponse === true,
    };

    const prompt = buildInjectionPrompt(message);
    const injected = this.client.injectMessage(prompt, ctx);

    if (!injected) {
      console.error(`[Bridge] Injection failed, re-queuing ${message.messageId}`);
      this.pendingQueue.unshift({ message, retries: retries + 1, enqueuedAt: Date.now() });
      setTimeout(() => this.drainQueue(), RETRY_DELAY_MS);
    } else {
      // Record the injection BEFORE the ack so a re-broadcast that races with the
      // ack-write can't slip through the dedup check.
      this.injectedMessageIds.add(message.messageId);
      void this.channelTransport.postChannelAck({
        conversationId: message.conversationId,
        messageId: message.messageId,
        state: "displayed_to_client",
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail: "Submitted to Codex app-server via turn/start",
      });
    }
  }

  private drainQueue(): void {
    if (this.pendingQueue.length === 0) return;
    if (this.client.turnInProgress) return;
    if (!this.client.currentThreadId) return;

    const item = this.pendingQueue.shift();
    if (item) {
      if (item.retries >= MAX_RETRIES) {
        console.error(`[Bridge] Dropping message ${item.message.messageId} after ${MAX_RETRIES} retries`);
        void this.channelTransport.postChannelAck({
          conversationId: item.message.conversationId,
          messageId: item.message.messageId,
          state: "failed",
          actorId: this.clientAgentId ?? "codex-app-bridge",
          actorType: "bridge",
          detail: `Dropped after ${MAX_RETRIES} injection retries`,
        });
        return;
      }
      this.injectNow(item.message, item.retries);
    }
  }

  private async failStaleQueuedMessages(now = Date.now()): Promise<void> {
    if (this.pendingQueue.length === 0) return;
    if (this.client.currentThreadId) return;

    const stillPending: QueuedMessage[] = [];
    const stale: QueuedMessage[] = [];
    for (const item of this.pendingQueue) {
      if (now - item.enqueuedAt >= NO_TUI_QUEUE_TIMEOUT_MS) stale.push(item);
      else stillPending.push(item);
    }

    if (stale.length === 0) return;
    this.pendingQueue.length = 0;
    this.pendingQueue.push(...stillPending);

    const detail =
      `No Codex TUI attached to bridge app-server. Run: ` +
      `codex --remote ws://127.0.0.1:${this.appServerPort}`;
    for (const item of stale) {
      console.error(`[Bridge] Failing queued message ${item.message.messageId}: ${detail}`);
      await this.channelTransport.postChannelAck({
        conversationId: item.message.conversationId,
        messageId: item.message.messageId,
        state: "failed",
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail,
      });
    }
  }

  // The injection prompt is built by the shared `injection-prompt` module so the
  // bridge emits consistent, prompt-engineered text into the Codex CLI.

  // ── Reply sending ───────────────────────────────────────────────────────────

  private async sendReplyToRegistry(text: string, ctx: InjectionContext): Promise<void> {
    if (!ctx.expectsResponse) {
      console.error(`[Bridge] Suppressing channel reply for fire-and-forget message ${ctx.messageId}`);
      return;
    }

    try {
      await this.channelTransport.postChannelMessage({
        fromAgentId: this.clientAgentId!,
        toAgentId: ctx.fromAgentId,
        conversationId: ctx.conversationId,
        replyTo: ctx.messageId,
        content: text,
        kind: "chat",
        expectsResponse: false,
      });

      await this.channelTransport.postChannelAck({
        conversationId: ctx.conversationId,
        messageId: ctx.messageId,
        state: "answered",
        actorId: this.clientAgentId ?? "codex-app-bridge",
        actorType: "bridge",
        detail: "Codex responded via agentMessage",
      });

      console.error(`[Bridge] Reply sent for conversation ${ctx.conversationId}`);
    } catch (err) {
      console.error(
        `[Bridge] Failed to send reply: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
}
