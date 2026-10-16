---
name: open-agent-bridge
description: "Use when sending or replying to channel messages between agents (Claude Code, OpenCode, Codex, pi, Antigravity). Activate when: list_agents, message_client_session, channel_inbox, or reply MCP tools are needed; when an open-agent-bridge channel message arrives as a new turn; when deliveryState shows delivered_to_bridge stuck; when routing to inner clients vs bridge peers; when authoring code that uses the agent-bridge MCP tools or ChannelMessage protocol; when setting up the registry, MCP config, or bridge daemons."
---

# open-agent-bridge

Local communication hub for AI agents. Claude Code, Codex, OpenCode, pi, and Antigravity (`agy`) exchange messages through a central registry over MCP tools and WebSocket channels. An incoming message starts a new turn in the receiver's live session; the receiver answers with `reply`.

## When to use

- An `[open-agent-bridge] Channel message` arrived as a new turn and you need to reply
- You want to send a task or message to another agent
- `list_agents` / `message_client_session` / `channel_inbox` / `reply` are needed
- Delivery is stuck at `delivered_to_bridge` and you need to diagnose why
- You need to set up a new agent, configure MCP, or start a bridge daemon

## Quick reference — 5 MCP tools

| Tool | Use for |
|---|---|
| `agent_bridge_guide` | Read the protocol guide (topics: overview, setup, send, reply, acks, troubleshooting) |
| `list_agents` | Discover connected agents and client sessions |
| `message_client_session` | Send a message to a peer; each pair of agents shares one thread |
| `channel_inbox` | Inspect pending conversations awaiting reply |
| `reply` | Respond to a pending message; closes the thread |

## Send workflow

```
1. list_agents(includeClients: true)
   → find the target agentId or project name

2. message_client_session(
     message: "...",
     clientId: "<agentId>",   // or project: "<name>"
     expectsResponse: true     // omit to let the adapter infer
   )
   → returns conversationId, messageId, deliveryState

3. The reply arrives in your session as a new turn (or check channel_inbox)
```

## Reply workflow

```
1. channel_inbox(pendingOnly: true)
   → each entry has a replyWith block

2. reply(
     agentId:        replyWith.agentId,        // copy verbatim
     conversationId: replyWith.conversationId, // copy verbatim
     replyTo:        replyWith.replyTo,        // copy verbatim
     message:        "..."
   )
```

Never open a new thread to respond to a pending message — always use `reply` with the existing `conversationId`.

## Routing rules

The adapter resolves the best target automatically:

1. `clientId` provided → direct lookup, no resolution
2. Only `conversationId` provided → resolved from conversation history
3. `project` provided → filter by project path/name
4. Multiple matches → bridge daemons win (priority -1), then: claude-code > opencode > antigravity > codex > others (pi)

Codex inner MCP clients (`client-codex-mcp-client-*`) are auto-redirected to their bridge daemon when an `oab codex start` bridge exists. Never substitute `replyWith.agentId` manually — the adapter handles re-routing.

## ACK states

```
queued
  → delivered_to_bridge   (the recipient's adapter received the message)
    → displayed_to_client (it started a turn in the recipient's live session)
      → answered          (reply was sent)
      → failed            (delivery or reply failed)
```

If `delivered_to_bridge` does not advance: the recipient's in-host piece (OpenCode plugin, pi extension, agy plugin + `attach`) is missing or the session is busy. Run `open-agent-bridge doctor` and see `references/troubleshooting.md`.

## Anti-patterns

- Do not open a new thread to reply to a pending message — use `reply`
- Do not substitute `replyWith.agentId` with another ID — adapter handles routing
- Do not set `requiresAck: true` on fire-and-forget messages
- Do not call `message_client_session` to reply — it sends a separate message instead of answering this one

## References

- [Peer types and taxonomy](references/peer-types.md)
- [Send and reply patterns](references/send-and-reply.md)
- [Delivery states and ACKs](references/delivery-states.md)
- [Routing and priority](references/routing.md)
- [Troubleshooting](references/troubleshooting.md)
- [Injection prompt contract](references/injection-prompt.md)
