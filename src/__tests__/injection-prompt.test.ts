import { describe, expect, it } from "vitest";
import { buildInjectionPrompt } from "../client/injection-prompt.js";
import type { ChannelMessage } from "../types/messages.js";

/**
 * Contract tests for the prompt that the bridge daemons inject as a turn into
 * Codex / Gemini CLIs. The prompt is the only piece of "instruction" the
 * receiving LLM gets when a channel message arrives, so its format is part of
 * the public contract:
 *
 * - All values needed by the `reply` tool must appear verbatim, so the LLM can
 *   copy-paste them without derivation.
 * - The body must be wrapped in BEGIN/END markers so the LLM cannot conflate
 *   sender content with adapter instructions (also a defense against prompt
 *   injection inside the message body).
 * - `expectsResponse=false` must NOT include a reply template — instead it
 *   must explicitly tell the receiver not to call `reply`.
 */

function makeMessage(overrides: Partial<ChannelMessage> = {}): ChannelMessage {
  return {
    conversationId: "conv-abc-123",
    messageId: "msg-xyz-789",
    fromAgentId: "client-claude-code-2d1c3fdb0c6a",
    fromAgentName: "rcm-worker",
    toAgentId: "client-codex-bridge-542cb39c4e74",
    kind: "chat",
    content: "Hello Codex, can you analyze the divergence?",
    createdAt: Date.now(),
    expectsResponse: true,
    ...overrides,
  };
}

describe("buildInjectionPrompt — reply required", () => {
  const prompt = buildInjectionPrompt(makeMessage({ expectsResponse: true }));

  it("uses the 'reply required' header (stronger than 'expected')", () => {
    expect(prompt).toContain(
      "[open-agent-bridge] Channel message — reply required",
    );
  });

  it("opens with an imperative 'Respond NOW' line so the action is unmissable", () => {
    expect(prompt).toMatch(/▶ Respond to the sender NOW/);
  });

  it("explains that silence blocks the sender", () => {
    expect(prompt).toMatch(/sender is\s+waiting|silence will block/i);
  });

  it("includes sender display name and the unique 8-char suffix", () => {
    // slice(-8) of "client-claude-code-2d1c3fdb0c6a" → "3fdb0c6a"
    expect(prompt).toContain("From:          rcm-worker (3fdb0c6a)");
  });

  it("includes the conversationId and messageId on dedicated lines", () => {
    expect(prompt).toContain("Conversation:  conv-abc-123");
    expect(prompt).toContain("Message ID:    msg-xyz-789");
  });

  it("wraps the content in BEGIN/END markers", () => {
    expect(prompt).toContain("----- BEGIN MESSAGE -----");
    expect(prompt).toContain("Hello Codex, can you analyze the divergence?");
    expect(prompt).toContain("----- END MESSAGE -----");
  });

  it("renders the reply tool signature with values literally expanded", () => {
    expect(prompt).toContain("agent-bridge.reply");
    expect(prompt).toContain('agentId:        "client-claude-code-2d1c3fdb0c6a"');
    expect(prompt).toContain('conversationId: "conv-abc-123"');
    expect(prompt).toContain('replyTo:        "msg-xyz-789"');
    expect(prompt).toContain('message:        "<your answer here>"');
  });

  it("steers away from message_client_session", () => {
    // The phrase "NOT … message_client_session" can straddle a line break in
    // the rendered template, so we match across newlines.
    expect(prompt).toMatch(/NOT[\s\S]*message_client_session/i);
  });

  it("frames the sender as a peer without the user's authority", () => {
    expect(prompt).toContain("This comes from another agent, not from your user.");
  });
});

describe("buildInjectionPrompt — replyTool", () => {
  it("names the reply tool the way the receiving client knows it", () => {
    const opts = { replyTool: "reply (open-agent-bridge MCP tool)" };
    const reply = buildInjectionPrompt(makeMessage({ expectsResponse: true }), opts);
    const info = buildInjectionPrompt(makeMessage({ expectsResponse: false }), opts);
    expect(reply).toContain("  reply (open-agent-bridge MCP tool)\n    agentId:");
    expect(info).toMatch(/do NOT call\s+reply \(open-agent-bridge MCP tool\)/);
    expect(reply + info).not.toContain("agent-bridge.reply");
  });
});

describe("buildInjectionPrompt — informational (no reply)", () => {
  const prompt = buildInjectionPrompt(makeMessage({ expectsResponse: false }));

  it("uses the 'informational' header", () => {
    expect(prompt).toContain(
      "[open-agent-bridge] Channel message — informational (no reply)",
    );
  });

  it("explicitly instructs NOT to call agent-bridge.reply", () => {
    expect(prompt).toMatch(/do NOT call[\s\S]*agent-bridge\.reply/i);
  });

  it("does NOT render a reply call template", () => {
    // The literal `agent-bridge.reply\n    agentId:` template must not appear.
    expect(prompt).not.toContain("agentId:        \"client-claude-code-2d1c3fdb0c6a\"");
    expect(prompt).not.toContain('replyTo:        "msg-xyz-789"');
  });

  it("still wraps the content in BEGIN/END markers", () => {
    expect(prompt).toContain("----- BEGIN MESSAGE -----");
    expect(prompt).toContain("----- END MESSAGE -----");
  });

  it("hints at message_client_session for follow-ups", () => {
    expect(prompt).toContain("message_client_session");
  });
});

describe("buildInjectionPrompt — expectsResponse=undefined defaults to reply required", () => {
  // Mirrors the conversation-session-store default and inferExpectsResponse
  // default — agent-to-agent messages with no explicit fire-and-forget marker
  // should be answered. The previous behavior (treating undefined as "no
  // reply") left senders waiting after a simple "hola".
  it("renders the 'reply required' header when expectsResponse is omitted", () => {
    const msg = makeMessage();
    delete (msg as Partial<ChannelMessage>).expectsResponse;
    const prompt = buildInjectionPrompt(msg);
    expect(prompt).toContain(
      "[open-agent-bridge] Channel message — reply required",
    );
    expect(prompt).toContain("agent-bridge.reply");
  });
});

describe("buildInjectionPrompt — taskId presence", () => {
  it("includes the Task line when taskId is set", () => {
    const prompt = buildInjectionPrompt(makeMessage({ taskId: "task-42" }));
    expect(prompt).toContain("Task:          task-42");
  });

  it("omits the Task line when taskId is absent", () => {
    const prompt = buildInjectionPrompt(makeMessage({ taskId: undefined }));
    expect(prompt).not.toContain("Task:");
  });
});

describe("buildInjectionPrompt — sender fallback", () => {
  it("falls back to fromAgentId when fromAgentName is missing", () => {
    const fromAgentId = "client-codex-mcp-client-aabbccdd1234";
    const expectedSuffix = fromAgentId.slice(-8); // "ccdd1234"
    const prompt = buildInjectionPrompt(
      makeMessage({ fromAgentName: undefined, fromAgentId }),
    );
    expect(prompt).toContain(`From:          ${fromAgentId} (${expectedSuffix})`);
  });

  it("uses exactly the last 8 chars of fromAgentId for the suffix", () => {
    const fromAgentId = "client-codex-mcp-client-aabbccdd1234";
    const expectedSuffix = fromAgentId.slice(-8);
    const prompt = buildInjectionPrompt(
      makeMessage({ fromAgentName: "codex-x", fromAgentId }),
    );
    expect(prompt).toContain(`From:          codex-x (${expectedSuffix})`);
  });
});
