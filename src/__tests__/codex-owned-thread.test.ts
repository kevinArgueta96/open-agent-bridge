import { describe, expect, it } from "vitest";
import { CodexAppServerClient } from "../client/codex-app-server-client.js";

/**
 * The bridge used to piggyback on whatever thread the Codex TUI created, which
 * meant no TUI => no delivery, and a TUI mid-turn => delivery blocked. It now
 * calls `thread/start` and owns a thread. These tests pin the two properties
 * that make that safe: we adopt our own thread, and the TUI can never take it
 * away from us again.
 */
type Internals = {
  startOwnThread: () => Promise<string | null>;
  interruptTurn: () => Promise<boolean>;
  sendRequest: (method: string, params: unknown, timeoutMs?: number) => Promise<unknown>;
  handleNotification: (message: unknown) => void;
  readTurnId: (params: Record<string, unknown> | undefined) => string | undefined;
  currentThreadId: string | null;
  ownsThread: boolean;
  turnInProgress: boolean;
};

function clientWithStub(
  responder: (method: string, params: unknown) => unknown,
): Internals & { calls: Array<{ method: string; params: unknown }> } {
  const client = new CodexAppServerClient({ cwd: "/tmp/proj" }) as unknown as Internals;
  const calls: Array<{ method: string; params: unknown }> = [];
  (client as { sendRequest: unknown }).sendRequest = async (method: string, params: unknown) => {
    calls.push({ method, params });
    return responder(method, params);
  };
  return Object.assign(client, { calls });
}

describe("CodexAppServerClient — bridge-owned thread", () => {
  it("adopts the thread returned by thread/start", async () => {
    const client = clientWithStub(() => ({ thread: { id: "own-1" } }));

    const id = await client.startOwnThread();

    expect(id).toBe("own-1");
    expect(client.ownsThread).toBe(true);
    expect(client.currentThreadId).toBe("own-1");
    expect(client.calls[0]?.method).toBe("thread/start");
    expect(client.calls[0]?.params).toMatchObject({
      cwd: "/tmp/proj",
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
    });
  });

  it("degrades to TUI-follow mode when the app-server has no thread/start", async () => {
    const client = clientWithStub(() => {
      throw new Error("unknown variant `thread/start`");
    });

    await expect(client.startOwnThread()).resolves.toBeNull();
    expect(client.ownsThread).toBe(false);
    expect(client.currentThreadId).toBeNull();
  });

  it("does not let a TUI thread/started steal our thread", async () => {
    const client = clientWithStub(() => ({ thread: { id: "own-1" } }));
    await client.startOwnThread();

    client.handleNotification({ method: "thread/started", params: { thread: { id: "tui-9" } } });

    expect(client.currentThreadId).toBe("own-1");
  });

  it("ignores turn activity on the TUI's thread so it cannot block delivery", async () => {
    const client = clientWithStub(() => ({ thread: { id: "own-1" } }));
    await client.startOwnThread();

    client.handleNotification({
      method: "thread/status/changed",
      params: { threadId: "tui-9", status: { type: "active" } },
    });

    expect(client.currentThreadId).toBe("own-1");
    expect(client.turnInProgress).toBe(false);
  });

  it("still follows the TUI thread when we do not own one (no regression)", () => {
    const client = new CodexAppServerClient() as unknown as Internals;

    client.handleNotification({ method: "thread/started", params: { thread: { id: "tui-9" } } });

    expect(client.ownsThread).toBe(false);
    expect(client.currentThreadId).toBe("tui-9");
  });

  it("reads the turn id from params.turn.id, with the flat form as fallback", () => {
    const client = new CodexAppServerClient() as unknown as Internals;

    expect(client.readTurnId({ turn: { id: "t-1" } })).toBe("t-1");
    expect(client.readTurnId({ turnId: "t-legacy" })).toBe("t-legacy");
    expect(client.readTurnId({})).toBeUndefined();
  });

  it("tracks the active turn id so a running turn can be interrupted", async () => {
    const client = clientWithStub((method) =>
      method === "thread/start" ? { thread: { id: "own-1" } } : {},
    );
    await client.startOwnThread();

    // No turn running yet — nothing to interrupt.
    await expect(client.interruptTurn()).resolves.toBe(false);

    client.handleNotification({ method: "turn/started", params: { turn: { id: "turn-7" } } });
    expect(client.turnInProgress).toBe(true);

    await expect(client.interruptTurn()).resolves.toBe(true);
    expect(client.calls.at(-1)).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "own-1", turnId: "turn-7" },
    });

    client.handleNotification({ method: "turn/completed", params: { turn: { id: "turn-7" } } });
    expect(client.turnInProgress).toBe(false);
    await expect(client.interruptTurn()).resolves.toBe(false);
  });
});

describe("CodexAppServerClient — turn/start effort and rejection", () => {
  const ctx = { conversationId: "c-1", messageId: "m-1", fromAgentId: "a-1", expectsResponse: true };

  function readyClient(effort: string | null) {
    const client = new CodexAppServerClient({ effort });
    const raw = client as unknown as Record<string, unknown>;
    const sent: Array<Record<string, unknown>> = [];
    raw.ws = { readyState: 1 }; // WebSocket.OPEN
    raw._initialized = true;
    raw._currentThreadId = "own-1";
    raw.send = (msg: Record<string, unknown>) => sent.push(msg);
    return { client, raw, sent };
  }

  it("sends the configured effort on turn/start, and nothing when unset", () => {
    const withEffort = readyClient("ultra");
    withEffort.client.injectMessage("hi", ctx);
    expect(withEffort.sent[0]?.params).toMatchObject({ threadId: "own-1", effort: "ultra" });

    const without = readyClient(null);
    without.client.injectMessage("hi", ctx);
    expect(without.sent[0]?.params).not.toHaveProperty("effort");
  });

  it("emits injectionRejected with the message context when turn/start fails", () => {
    const { client, raw, sent } = readyClient("ultra");
    const rejected: unknown[] = [];
    client.on("injectionRejected", (c, reason) => rejected.push([c, reason]));

    client.injectMessage("hi", ctx);
    (raw.handleResponse as (m: unknown) => void).call(client, {
      id: sent[0]?.id,
      error: { message: "unsupported effort" },
    });

    expect(rejected).toEqual([[ctx, "unsupported effort"]]);
    expect(client.turnInProgress).toBe(false);
  });
});
