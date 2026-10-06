import { EventEmitter } from "node:events";
import { WebSocket } from "ws";

// ── JSON-RPC types ───────────────────────────────────────────────────────────

interface JsonRpcMessage {
  method?: string;
  id?: number;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

// ── Injection context — correlates a bridge injection with a channel message ─

export interface InjectionContext {
  conversationId: string;
  messageId: string;
  fromAgentId: string;
  expectsResponse: boolean;
}

// ── Events ───────────────────────────────────────────────────────────────────

export interface CodexAppServerClientEvents {
  agentMessage: [text: string, ctx: InjectionContext | null];
  /** The app-server refused a turn/start we sent (bad params, thread gone…). */
  injectionRejected: [ctx: InjectionContext, reason: string];
  turnStarted: [turnId: string];
  turnCompleted: [turnId: string];
  threadDetected: [threadId: string];
  connected: [];
  disconnected: [];
}

export interface CodexAppServerClientOptions {
  /** WebSocket URL of the codex app-server. Default: ws://127.0.0.1:4500 */
  appServerUrl?: string;
  /** Working directory for the bridge-owned thread. Default: process.cwd() */
  cwd?: string;
  /** Sandbox for the bridge-owned thread. Channel work defaults to read-only. */
  sandbox?: "read-only" | "workspace-write";
  /** Model for the bridge-owned thread. null = let Codex pick its configured default. */
  model?: string | null;
  /** Reasoning effort sent on every turn/start. Codex makes it sticky for the
   *  thread, and `ultra` is what turns on proactive sub-agent delegation.
   *  null = the model's configured default. */
  effort?: string | null;
}

/** Identifies this client to Codex in `thread/start`. */
const SERVICE_NAME = "open_agent_bridge";

/**
 * Direct WebSocket client to the Codex app-server.
 *
 * Connects as an independent client (separate from the TUI) and performs the
 * required JSON-RPC `initialize` handshake. Monitors broadcast notifications
 * for turn lifecycle and agentMessage capture. Exposes injectMessage() to
 * send turn/start requests directly.
 */
export class CodexAppServerClient extends EventEmitter<CodexAppServerClientEvents> {
  private readonly appServerUrl: string;
  private readonly cwd: string;
  private readonly sandbox: "read-only" | "workspace-write";
  private readonly model: string | null;
  private readonly effort: string | null;

  private ws: WebSocket | null = null;
  private _initialized = false;

  // Turn tracking
  private _turnInProgress = false;
  private activeTurnIds = new Set<string>();
  /** Turn currently running on our own thread — the target for turn/interrupt. */
  private _activeTurnId: string | null = null;

  // Thread tracking
  private _currentThreadId: string | null = null;
  /** True once `thread/start` succeeded: we own the thread and receive its full
   *  notification stream. When false we are back to the legacy behaviour of
   *  piggybacking on whatever thread the TUI created. */
  private _ownsThread = false;

  // Request ID management
  private nextRequestId = 1;
  /** Pending requests waiting for a response, keyed by id */
  private readonly pendingRequests = new Map<
    number,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();

  // Injection tracking
  private readonly injectionContexts = new Map<number, InjectionContext>();
  private lastInjectionRequestId: number | null = null;

  // Item buffering for streaming agentMessage content
  private readonly itemContentBuffers = new Map<string, string>();

  constructor(options: CodexAppServerClientOptions = {}) {
    super();
    this.appServerUrl = options.appServerUrl ?? "ws://127.0.0.1:4500";
    this.cwd = options.cwd ?? process.cwd();
    this.sandbox = options.sandbox ?? "read-only";
    this.model = options.model ?? null;
    this.effort = options.effort ?? null;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get turnInProgress(): boolean {
    return this._turnInProgress;
  }

  get currentThreadId(): string | null {
    return this._currentThreadId;
  }

  /** True when the bridge created its own thread and no longer depends on a TUI. */
  get ownsThread(): boolean {
    return this._ownsThread;
  }

  get initialized(): boolean {
    return this._initialized;
  }

  /**
   * Connect to the app-server and perform the initialize handshake.
   */
  async connect(): Promise<void> {
    await this.openWebSocket();
    await this.performInitialize();
    await this.startOwnThread();
    console.error(`[CodexClient] Connected and initialized with ${this.appServerUrl}`);
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this._initialized = false;
    this._ownsThread = false;
  }

  /**
   * Create a thread the bridge OWNS, instead of waiting for the TUI to create
   * one and piggybacking on it.
   *
   * This is what makes channel delivery instant and independent of any TUI:
   * as the thread owner we can always start a turn (the user's TUI turn no
   * longer blocks us) and the app-server streams us the full notification set
   * for that thread — `item/completed` carries the answer text directly.
   *
   * Non-fatal: an app-server too old to know `thread/start` leaves us in the
   * legacy mode where `_currentThreadId` is adopted from the TUI.
   */
  async startOwnThread(): Promise<string | null> {
    if (this._ownsThread && this._currentThreadId) return this._currentThreadId;
    try {
      const result = (await this.sendRequest("thread/start", {
        cwd: this.cwd,
        model: this.model,
        approvalPolicy: "never",
        sandbox: this.sandbox,
        serviceName: SERVICE_NAME,
        ephemeral: true,
      })) as { thread?: { id?: string }; threadId?: string } | undefined;

      const threadId = result?.thread?.id ?? result?.threadId ?? null;
      if (!threadId) {
        console.error("[CodexClient] thread/start returned no thread id — staying in TUI-follow mode");
        return null;
      }

      this._currentThreadId = threadId;
      this._ownsThread = true;
      console.error(
        `[CodexClient] Owning thread ${threadId} (sandbox=${this.sandbox}) — delivery no longer needs a TUI`,
      );
      this.emit("threadDetected", threadId);
      return threadId;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[CodexClient] thread/start unavailable (${msg}) — falling back to TUI-follow mode`);
      return null;
    }
  }

  /**
   * Cancel the turn currently running on our own thread. No-op when we do not
   * own the thread — interrupting the user's TUI turn is never our call.
   */
  async interruptTurn(): Promise<boolean> {
    if (!this._ownsThread || !this._currentThreadId || !this._activeTurnId) return false;
    try {
      await this.sendRequest("turn/interrupt", {
        threadId: this._currentThreadId,
        turnId: this._activeTurnId,
      });
      return true;
    } catch (err) {
      console.error(`[CodexClient] turn/interrupt failed: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /**
   * Inject a message directly into the app-server as a turn/start request.
   */
  injectMessage(text: string, ctx: InjectionContext): boolean {
    if (!this._currentThreadId) {
      console.error("[CodexClient] Cannot inject: no thread ID yet");
      return false;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error("[CodexClient] Cannot inject: WS not open");
      return false;
    }
    if (!this._initialized) {
      console.error("[CodexClient] Cannot inject: not initialized");
      return false;
    }
    if (this._turnInProgress) {
      console.error("[CodexClient] Cannot inject: turn in progress");
      return false;
    }

    const requestId = this.nextRequestId++;
    this.injectionContexts.set(requestId, ctx);
    this.lastInjectionRequestId = requestId;
    this._turnInProgress = true;

    this.send({
      method: "turn/start",
      id: requestId,
      params: {
        threadId: this._currentThreadId,
        input: [{ type: "text", text }],
        ...(this.effort ? { effort: this.effort } : {}),
      },
    });

    console.error(
      `[CodexClient] Injected turn/start id=${requestId} thread=${this._currentThreadId}`,
    );
    return true;
  }

  // ── WebSocket connection ───────────────────────────────────────────────────

  private openWebSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.appServerUrl);

      ws.once("open", () => {
        this.ws = ws;
        this.emit("connected");
        resolve();
      });

      ws.on("message", (data) => this.handleMessage(String(data)));

      ws.on("close", () => {
        console.error("[CodexClient] WS closed");
        this.ws = null;
        this._initialized = false;
        this.emit("disconnected");
      });

      ws.on("error", (err) => {
        console.error("[CodexClient] WS error:", err.message);
        if (this.ws === null) reject(err);
      });
    });
  }

  // ── Initialize handshake ───────────────────────────────────────────────────

  private async performInitialize(): Promise<void> {
    const result = await this.sendRequest("initialize", {
      clientInfo: { name: "open-agent-bridge", version: "0.1.0" },
      capabilities: {},
      protocolVersion: "0.1.0",
    });

    console.error("[CodexClient] Initialize response:", JSON.stringify(result));

    // Send initialized notification (no id)
    this.send({ method: "initialized" });
    this._initialized = true;
  }

  // ── Message handling ───────────────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    const hasId = "id" in msg && msg.id !== undefined;
    const hasMethod = "method" in msg && msg.method !== undefined;
    const hasResult = "result" in msg;
    const hasError = "error" in msg;

    if (hasId && (hasResult || hasError) && !hasMethod) {
      // JSON-RPC response to our request
      this.handleResponse(msg);
    } else if (hasMethod && hasId) {
      // Server-initiated request (e.g. server.client_name) — respond
      this.handleServerRequest(msg);
    } else if (hasMethod && !hasId) {
      // Notification (broadcast from app-server)
      this.handleNotification(msg);
    }
  }

  private handleResponse(msg: JsonRpcMessage): void {
    const id = msg.id!;

    // Check if this is a response to a turn/start injection
    if (this.injectionContexts.has(id)) {
      if (msg.error) {
        console.error(
          `[CodexClient] Injection id=${id} rejected: ${msg.error.message}`,
        );
        this.emit("injectionRejected", this.injectionContexts.get(id)!, msg.error.message);
        this.injectionContexts.delete(id);
        if (this.lastInjectionRequestId === id) this.lastInjectionRequestId = null;
        this._turnInProgress = false;
        this.emit("turnCompleted", `turn-error-${id}`);
      } else {
        // Fallback: extract response from the turn/start result. The app-server returns
        // the full turn output in the JSON-RPC response, but item/completed notifications
        // may NOT be delivered to non-owner WS connections (the bridge is a 2nd client,
        // not the TUI). If item/completed already consumed the context, this is a no-op.
        const ctx = this.injectionContexts.get(id)!;
        const text = this.extractTurnResponseText(msg.result);
        if (text) {
          this.injectionContexts.delete(id);
          if (this.lastInjectionRequestId === id) this.lastInjectionRequestId = null;
          this.emit("agentMessage", text, ctx);
          if (this._turnInProgress) {
            this._turnInProgress = false;
            this.emit("turnCompleted", `turn-response-${id}`);
          }
        }
        // If no text in the result, keep context alive for item/completed notifications
      }
    }

    // Resolve pending request promise
    const pending = this.pendingRequests.get(id);
    if (pending) {
      this.pendingRequests.delete(id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  /**
   * Extract agent message text from a turn/start JSON-RPC response result.
   * Known app-server builds have returned slightly different shapes:
   * { output: [{ type: "agentMessage", content: [...] }] },
   * { items: [...] }, or nested item/message objects. Keep this tolerant so a
   * successful Codex answer is not lost just because the result shape changed.
   */
  private extractTurnResponseText(result: unknown): string {
    return this.extractAgentText(result);
  }

  private extractAgentText(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    if (Array.isArray(value)) {
      return value.map((item) => this.extractAgentText(item)).join("");
    }

    const obj = value as Record<string, unknown>;
    const type = typeof obj["type"] === "string" ? obj["type"].toLowerCase() : "";
    const role = typeof obj["role"] === "string" ? obj["role"].toLowerCase() : "";
    const looksLikeAssistant =
      type.includes("agent") ||
      type.includes("assistant") ||
      role === "assistant" ||
      type === "output_text";

    if (looksLikeAssistant && typeof obj["text"] === "string") {
      return obj["text"];
    }

    let text = "";
    for (const key of ["content", "output", "items", "message", "item", "data"]) {
      if (key in obj) text += this.extractAgentText(obj[key]);
    }
    return text;
  }

  private handleServerRequest(msg: JsonRpcMessage): void {
    const method = msg.method!;
    const id = msg.id!;

    // Respond to known server-initiated requests
    switch (method) {
      case "server.client_name":
        this.send({ id, result: "open-agent-bridge" });
        console.error("[CodexClient] Responded to server.client_name");
        break;
      case "server.client_version":
        this.send({ id, result: "0.1.0" });
        console.error("[CodexClient] Responded to server.client_version");
        break;
      default:
        // Unknown server request — respond with empty result to avoid timeout
        console.error(`[CodexClient] Unknown server request: ${method}, responding with null`);
        this.send({ id, result: null });
        break;
    }
  }

  private handleNotification(msg: JsonRpcMessage): void {
    const method = msg.method!;
    const params = msg.params as Record<string, unknown> | undefined;

    // Log all notifications for debugging (first 300 chars)
    const raw = JSON.stringify(msg);
    console.error(`[CodexClient] notif: ${raw.length > 300 ? raw.slice(0, 300) + "…" : raw}`);

    switch (method) {
      case "thread/started": {
        // threadId is nested under params.thread.id
        const thread = params?.thread as Record<string, unknown> | undefined;
        const threadId = (thread?.id as string | undefined) ?? (params?.threadId as string | undefined);
        // We own our thread: a thread the TUI just opened is none of our
        // business, and adopting it would put us back to piggybacking.
        if (this._ownsThread && threadId !== this._currentThreadId) break;
        if (threadId) {
          this._currentThreadId = threadId;
          console.error(`[CodexClient] Thread detected via thread/started: ${threadId}`);
          this.emit("threadDetected", threadId);
          void this.subscribeToThread(threadId);
        }
        break;
      }

      case "thread/status/changed": {
        // Use this as the primary turn-state signal since turn/started and
        // turn/completed may not be broadcast to non-owner connections.
        const threadId = params?.threadId as string | undefined;
        const status = params?.status as Record<string, unknown> | undefined;
        const statusType = status?.type as string | undefined;

        // When we own a thread, status changes for the TUI's thread must not
        // move our injection target nor mark US as busy — otherwise the user
        // typing in their TUI would block channel delivery again.
        if (this._ownsThread && threadId && threadId !== this._currentThreadId) break;

        // Legacy TUI-follow mode: Codex can emit thread/started for one thread
        // and then status changes for the TUI's active thread. Track the latest
        // status thread as the injection target; otherwise messages can sit
        // forever behind a stale thread id.
        if (!this._ownsThread && threadId && threadId !== this._currentThreadId) {
          this._currentThreadId = threadId;
          console.error(`[CodexClient] Thread detected via status/changed: ${threadId}`);
          this.emit("threadDetected", threadId);
          void this.subscribeToThread(threadId);
        }

        if (!threadId || threadId === this._currentThreadId) {
          if (statusType === "idle") {
            if (this._turnInProgress) {
              this._turnInProgress = false;
              // Emit a synthetic turnCompleted so the bridge drains its queue
              this.emit("turnCompleted", "status-idle");
            }
          } else if (statusType === "active") {
            this._turnInProgress = true;
          }
        }

        console.error(`[CodexClient] Thread status: ${statusType}`);
        break;
      }

      case "turn/started": {
        const turnId = this.readTurnId(params);
        if (turnId) {
          this.activeTurnIds.add(turnId);
          this._activeTurnId = turnId;
          this._turnInProgress = true;
          this.emit("turnStarted", turnId);
        }
        break;
      }

      case "turn/completed": {
        const turnId = this.readTurnId(params);
        if (turnId) {
          this.activeTurnIds.delete(turnId);
          if (this._activeTurnId === turnId) this._activeTurnId = null;
          if (this.activeTurnIds.size === 0) {
            this._turnInProgress = false;
          }
          this.emit("turnCompleted", turnId);
        }
        break;
      }

      case "item/started": {
        const item = params?.item as Record<string, unknown> | undefined;
        if (item?.type === "agentMessage" && item.id) {
          this.itemContentBuffers.set(String(item.id), "");
        }
        break;
      }

      case "item/agentMessage/delta": {
        const itemId = params?.itemId as string | undefined;
        const delta = (params?.delta as Record<string, unknown> | undefined)
          ?.text;
        if (
          itemId &&
          typeof delta === "string" &&
          this.itemContentBuffers.has(itemId)
        ) {
          this.itemContentBuffers.set(
            itemId,
            (this.itemContentBuffers.get(itemId) ?? "") + delta,
          );
        }
        break;
      }

      case "item/completed": {
        const item = params?.item as Record<string, unknown> | undefined;
        if (item) {
          const itemId = item.id ? String(item.id) : undefined;
          const buffered = itemId ? this.itemContentBuffers.get(itemId) : undefined;
          if (itemId) this.itemContentBuffers.delete(itemId);

          const text = buffered || this.extractAgentText(item);
          const ctx =
            text && this.lastInjectionRequestId !== null
              ? (this.injectionContexts.get(this.lastInjectionRequestId) ??
                  null)
              : null;

          if (text && ctx) {
            this.injectionContexts.delete(this.lastInjectionRequestId!);
            this.lastInjectionRequestId = null;
            this.emit("agentMessage", text, ctx);
          }

          if (text && this._turnInProgress) {
            this._turnInProgress = false;
            this.emit("turnCompleted", ctx ? "agentMessage-received" : "item-completed");
          }
        }
        break;
      }
    }
  }

  /** Turn id lives at `params.turn.id`; older drafts used a flat `params.turnId`. */
  private readTurnId(params: Record<string, unknown> | undefined): string | undefined {
    const turn = params?.turn as Record<string, unknown> | undefined;
    return (turn?.id as string | undefined) ?? (params?.turnId as string | undefined);
  }

  // ── Thread subscription ────────────────────────────────────────────────────

  /**
   * Call thread/resume on our connection to subscribe to notifications for this
   * thread. Without this the app-server may only send turn/item notifications to
   * the TUI connection that created/owns the thread.
   */
  private async subscribeToThread(threadId: string): Promise<void> {
    // Owning the thread already gives us its full notification stream.
    if (this._ownsThread) return;
    try {
      const result = await this.sendRequest("thread/resume", { threadId });
      console.error(`[CodexClient] thread/resume result: ${JSON.stringify(result)}`);
    } catch (err) {
      // thread/resume may fail if not supported or thread not found — ignore
      console.error(`[CodexClient] thread/resume failed (non-fatal): ${err instanceof Error ? err.message : err}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private send(msg: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  private sendRequest(
    method: string,
    params: unknown,
    timeoutMs = 10_000,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextRequestId++;

      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request ${method} (id=${id}) timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.send({ method, id, params });
    });
  }
}
