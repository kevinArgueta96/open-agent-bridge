# Injection Prompt Contract

Every client (Claude Code, Codex, OpenCode, pi, Antigravity) gets an inbound channel message as a new turn whose text is this structured prompt (`buildInjectionPrompt`). This contract is locked by `src/__tests__/injection-prompt.test.ts`. The excerpts below are abridged; the live prompt also warns that the message comes from another agent, not the user.

## Reply-required format

```
[open-agent-bridge] Channel message — reply required
===============================================
From:          <sender name> (<8-char agentId suffix>)
Conversation:  <conversationId>
Message ID:    <messageId>

----- BEGIN MESSAGE -----
<original message content>
----- END MESSAGE -----

▶ Respond to the sender NOW with the agent-bridge MCP. The sender is
  waiting on this turn — silence will block them.

Tool call (copy each field verbatim — the adapter handles routing):

  reply (open-agent-bridge MCP tool)
    agentId:        "<fromAgentId>"
    conversationId: "<conversationId>"
    replyTo:        "<messageId>"
    message:        "<your answer here>"

How to compose the reply:
  1. Do any local work the sender's message implies ...
  2. Put your answer or finding in the `message` field.
  ...
```

## Informational (no-reply) format

When `expectsResponse` resolves to `false`:

```
[open-agent-bridge] Channel message — informational (no reply)
===============================================
From:          <sender name> (<suffix>)
Conversation:  <conversationId>
Message ID:    <messageId>

----- BEGIN MESSAGE -----
<original message content>
----- END MESSAGE -----

The sender flagged this as informational — do NOT call
reply (open-agent-bridge MCP tool). ...
```

## Rules for receiving agents

- The IDs in the tool call template (`agentId`, `conversationId`, `replyTo`) are literal — copy them verbatim.
- Do not derive or reconstruct the IDs. The adapter handles routing, including the Codex inner-to-bridge redirect.
- For reply-required messages: call `reply` after completing any work the message implies.
- For informational messages: do NOT call `reply`. Process the content as context.

## Why this structure exists

- The `BEGIN MESSAGE / END MESSAGE` delimiters prevent prompt injection via message content.
- Literal IDs in the tool call template eliminate lookup errors.
- The `replyTo` field ensures the response threads correctly to the specific message.
- The header wording (`reply required` vs `informational`) lets the receiving LLM make a binary decision without reasoning about `expectsResponse` semantics.

## Claude Code fallback

Claude Code ≥ 2.1.224 gets this same prompt through its inbox socket. Only when the socket is unavailable (older releases launched with `oab claude --legacy-channels`) does it receive the raw `<channel>` push event instead:

```xml
<channel source="open-agent-bridge"
         from_agent="<agentId>"
         agent_name="<name>"
         conversation_id="<conversationId>"
         message_id="<messageId>"
         kind="chat">
  <message content>
</channel>
```

Claude Code decides whether to reply based on conversation context and the `expectsResponse` field surfaced in the `<channel>` tag attributes.

## Source file

Implementation: `src/client/injection-prompt.ts`
Test contract: `src/__tests__/injection-prompt.test.ts`

Do not edit the BEGIN/END markers, header wording, or ID field names without updating the test.
