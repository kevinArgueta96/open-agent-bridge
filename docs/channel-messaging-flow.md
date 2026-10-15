# Channel messaging flow

How a message travels from the LLM's tool call through the MCP adapter, the registry, and into another agent's inbox.

This document covers the end-to-end path of `message_client_session` (and its sibling `reply`) — the tools an agent uses to push a message into another agent's channel inbox via `open-agent-bridge`.

## TL;DR

- **Send path is HTTP**, **receive path is WebSocket**. The agent posts to `POST /channel/messages` on the registry; the registry persists to SQLite and pushes the event to the recipient's WS socket.
- The MCP adapter exposes 4 tools: `list_agents`, `channel_inbox`, `message_client_session`, `reply`. Their handlers all sit on top of one stack: `ConversationService → ChannelClientRuntime → ChannelTransport`.
- `conversationId` is **deterministic** (`sha1(sortedAgentIds)`), so both sides converge on the same thread without a handshake.
- Delivery state is a small **state machine** (`queued → delivered_to_bridge → displayed_to_client → answered|failed`) used by the sender to decide whether to wait inline for a reply or return early.
- The dashboard sees everything via a global broadcast; the recipient receives a targeted send via `agentWsMap[toAgentId]`.

## Layered architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│  LLM host (Claude Code, Codex, Gemini)                               │
└──────────────────────────────────────────────────────────────────────┘
                              │  MCP tool call
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  src/mcp/adapter.ts          McpAgentBridge                          │
│   • registers tools (zod schemas)                                    │
│   • client identity + profile resolution                             │
│   • notification fan-out to LLM host                                 │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  src/client/conversation-service.ts   ConversationService            │
│   • startConversation / replyAndAcknowledge                          │
│   • waitForAcknowledgement (poll on state machine)                   │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  src/client/channel-client-runtime.ts  ChannelClientRuntime          │
│   • WS connection + reconnect (jittered backoff)                     │
│   • local ConversationSessionStore                                   │
│   • sendMessage / reply / acknowledgeMessage                         │
│   • emits: channel.message, channel.ack, conversation.updated        │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  src/client/channel-transport.ts       ChannelTransport              │
│   • POST /channel/messages    (send)                                 │
│   • POST /channel/acks        (ack)                                  │
│   • WS  /ws + identify frame  (receive)                              │
└──────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────────────────┐
│  src/registry/server.ts                RegistryServer (:4999)        │
│   • express + ws                                                     │
│   • channelStore (SQLite)                                            │
│   • eventBus.broadcast + agentWsMap[toAgentId].send                  │
└──────────────────────────────────────────────────────────────────────┘
```

## Tool surface (what the LLM sees)

All four are registered in `McpAgentBridge.registerMetaTools()` (`src/mcp/adapter.ts`).

| Tool                     | Purpose                                                          | Key inputs                                                                |
| ------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `list_agents`            | Discover agents and client sessions                              | `skill?`, `project?`, `healthyOnly?`, `includeClients?`                   |
| `channel_inbox`          | Inspect this client's pending inbound conversations              | `pendingOnly?`, `expiredOnly?`, `limit?`, `includeMessages?`              |
| `message_client_session` | **Initiate or continue** a thread to another client session      | `clientId? \| project?`, `message`, `conversationId?`, `expectsResponse?` |
| `reply`                  | Respond to a pending inbound message and mark thread `answered`  | `agentId`, `conversationId`, `replyTo`, `message`                         |

Each handler validates its inputs with `zod`, resolves the target via the registry, then drops into the same `ConversationService` stack.

## Send path (step by step)

The LLM calls `message_client_session({ clientId, message, ... })`. The handler is `handleMessageClientSession` in `src/mcp/adapter.ts`.

### 1. Resolve the target client

`resolveClientSession()` queries `RegistryClient.listAgents()` (HTTP `GET /agents`) and filters `entryType === "client"`. Resolution order:

1. **Exact `clientId` match** (most reliable).
2. Fallback by client-name prefix extracted from a stale `clientId` (handles client restarts).
3. Lookup via `conversationId` participants if no `clientId` / `project` given.
4. `project` substring match against `projectName` / `projectPath`.
5. Optional filter by `clientType` (`claude-code` | `codex` | `gemini`).
6. On multiple matches, sort by `CLIENT_PRIORITY` (`claude-code > gemini > codex`); `app-server-bridge` daemons always win because they inject the message as a turn into a running app-server.

The dashboard UI (`open-agent-bridge:client-dashboard-ui`) is excluded from valid targets.

### 2. Build a deterministic conversationId

```ts
sha1(sorted([fromAgentId, toAgentId]))   // → UUID-v4-shaped string
```

Both sides compute the same id, so a reply doesn't need handshake state — the recipient's `channel_inbox` already shows the same thread.

### 3. Hand off to the service

`ConversationService.startConversation({ toAgentId, message, expectsResponse, requiresAck, expiresAt, conversationId })` calls `ChannelClientRuntime.sendMessage(...)`, which:

1. Calls `ChannelTransport.postChannelMessage(...)` → **HTTP POST** `/channel/messages` to the registry.
2. On success, records the message in the local `ConversationSessionStore` so future `getSnapshot()` / `waitForAcknowledgement` calls can see it.

### 4. Registry persists and routes

Handler in `src/registry/server.ts`:

```ts
app.post("/channel/messages", (req, res) => {
  // 1. Validate fromAgentId, kind, content
  // 2. channelStore.createMessage(...)        ← SQLite persist
  // 3. If conversation was suppressed, broadcast channel.conversation.revived FIRST
  //    (so receivers clear their deletedConversationIds before tracking the message)
  // 4. eventBus.broadcast({ type: "channel.message", data: message })
  //    → fan-out to ALL connected WS clients (dashboard, observers)
  // 5. If message.toAgentId is set:
  //    agentWsMap.get(toAgentId)?.send({ type: "channel.message", data: message })
  //    → targeted delivery to the recipient's identified WS socket
});
```

**Two-tier delivery** — the eventBus broadcast covers observers (the dashboard). The targeted `agentWsMap` send guarantees the recipient receives it even if it isn't subscribed to the global broadcast.

### 5. WS identification (how `agentWsMap` is built)

When a runtime opens a WS to `/ws`, it sends:

```json
{ "type": "identify", "agentId": "client-claude-code-..." }
```

The registry stores `agentWsMap[agentId] = ws`. Re-identification on the same socket is a no-op; identification on a new socket evicts the previous mapping. This is what enables targeted delivery in step 4.

### 6. Sender waits (or returns)

After posting, `handleMessageClientSession` waits on the **delivery state machine** via `ConversationService.waitForAcknowledgement(...)`:

- **Phase 1** (≤ 3s, all clients): wait for any of `delivered_to_bridge | displayed_to_client | answered | failed`. This catches "the bridge got it".
- **Phase 2** (only for clients without native delivery — older Codex, Antigravity — when `expectsResponse=true`): wait up to `timeoutMs` (capped at 120s) for `answered | failed`.

Why the asymmetry: Claude Code (inbox socket), OpenCode (plugin) and Codex ≥ 0.162 (app-server daemon) receive messages as a new turn in the live session, even while idle. If we blocked the tool, the incoming reply notification couldn't be processed — so we return fast and let the inbox surface the reply asynchronously. Codex/Gemini cannot react to a `notifications/message` log line after a tool returns, so we must keep waiting and return the reply inline.

## Receive path (the other side)

Both sides run the same `ChannelClientRuntime`. On the recipient:

### 1. WS frame arrives

`ChannelClientRuntime.handleRawMessage(raw)`:

```ts
if (event.type === "channel.message" && event.data) {
  const message = event.data as ChannelMessage;
  if (this.emittedMessageIds.has(message.messageId)) return;        // dedup
  const updatedState = this.conversationStore.trackMessage(message); // local state
  this.emittedMessageIds.add(message.messageId);
  this.emitConversationUpdate(updatedState);
  this.emitter.emit("channel.message", message);                     // → adapter
}
```

Dedup uses an in-memory `Set` with a TTL; the `ConversationSessionStore` tracks `messageIds`, `pendingMessageIds`, `lastAckState`, `awaitingReply`.

### 2. Adapter receives the event

`McpAgentBridge.setupChannelRuntime()` listens for `"channel.message"`:

1. **Pre-init buffering**: if MCP `initialize` hasn't completed yet (`clientAgentId === null`), the message is queued in `pendingPreInitMessages` (max 100, oldest dropped). Drained after the client identifies itself.
2. **Profile filter**: `clientProfile.acceptsChannelMessage(message, selfAgentId)` decides whether this client cares about the message (broadcast vs. targeted, etc.).
3. **`deliverChannelMessage(message)`**:
   - Posts ack `delivered_to_bridge` (HTTP POST `/channel/acks`).
   - **Native delivery first** (claims the messageId before the async write, releases it on failure):
     - **Claude profile** with `$CLAUDE_CODE_MESSAGING_SOCKET` → `buildInjectionPrompt()` written to Claude Code's inbox socket; runs as the next turn. Ack `displayed_to_client` ("injected via Claude Code inbox socket").
     - **Codex profile** with the app-server daemon socket → `turn/start` on the session's own thread (waits for idle); ack "injected into the live Codex session". On failure the message stays pending for the next sync — no notification fallback, Codex ignores them.
   - Otherwise maps the channel message to a JSON-RPC notification via `clientProfile.mapChannelMessage()`:
     - **Claude profile** → `notifications/claude/channel` (experimental capability `claude/channel`) — legacy fallback, only rendered when Claude Code runs with `--dangerously-load-development-channels`.
     - **Codex / Gemini profiles** → `notifications/message` (standard MCP log line; not reactive — these clients see replies in the tool result instead).
   - Calls `server.server.notification(notification)` with 2 retries, 500ms × attempt backoff.
   - Posts ack `displayed_to_client`.

### 3. Reply tool closes the loop

When the receiving LLM calls `reply(agentId, conversationId, replyTo, message)`, the same `ConversationService.replyAndAcknowledge` path runs:

1. Posts the reply as a new channel message back to the registry.
2. Posts an ack with `state: "answered"` against the *original* `replyTo` message — this is what unblocks the original sender's `waitForAcknowledgement`.

## Storage model — `src/registry/channel-store.ts`

SQLite (`node:sqlite` `DatabaseSync`), three tables:

```sql
channel_messages (
  message_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL                -- full ChannelMessage
);

channel_acks (
  ack_id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  payload_json TEXT NOT NULL                -- full ChannelAck
);

channel_suppressed_conversations (
  conversation_id TEXT PRIMARY KEY,
  suppressed_at INTEGER NOT NULL
);
```

The full envelope is stored as JSON for forward-compat — schema changes don't require migrations. Queries are indexed by `(conversation_id, created_at | timestamp)`.

This is also the **source of truth for replay**: after a WS reconnect, `syncRegistryToLocalStore()` calls `GET /channel/conversations` + `GET /channel/conversations/:id`, hydrates the local `ConversationSessionStore`, and re-delivers messages whose `messageId` was never surfaced (`surfacedInboxMessageIds`).

## Delivery state machine

```
                                 ┌─────────┐
        message posted           │ queued  │  (registry, on POST /channel/messages)
   ────────────────────────────▶ └────┬────┘
                                      │
                                      ▼
                              ┌──────────────────────┐
        runtime emits         │ delivered_to_bridge  │  (recipient adapter, on receive)
        "channel.message"     └────────────┬─────────┘
                                           │
                                           ▼
                                ┌────────────────────┐
        notification           │ displayed_to_client │  (after server.notification succeeds)
        pushed to LLM          └─────────┬──────────┘
                                          │
                                          ▼
                              ┌──────────────────────┐
        recipient calls        │      answered       │  (on reply with acknowledgementState)
        reply tool             └──────────────────────┘

                                Failure path: failed   (notification push permanently failed)
```

`waitForAcknowledgement(states: [...])` polls `lastAckState` every 150ms (configurable) until a target state is seen or the timeout elapses.

## Lifecycle hooks

- **Auto-bootstrap**: if no registry is reachable at `localhost:4999` and `auto: true` (default), the adapter starts an embedded `RegistryServer` in-process (`ensureInfrastructure()`). Cleaned up on `SIGINT` / `SIGTERM` / `beforeExit`.
- **Client identification**: `setupClientDetection()` hooks `oninitialized` on the underlying SDK server. On the first `initialize` it:
  1. Reads `clientName` / `clientVersion`.
  2. Calls `listRoots` (MCP roots protocol) to learn the real workspace path.
  3. Builds a stable `agentId = client-${clientName}-${sha1(clientName + projectPath).slice(0,12)}`.
  4. Calls `channelRuntime.activateClient(registration)` → registers via the registry.
  5. Calls `syncRegistryToLocalStore()` to backfill the inbox.
  6. Drains `pendingPreInitMessages`.
- **Reconnect**: jittered exponential backoff (max 30s). On each `ws.open`, the adapter triggers a fresh `syncRegistryToLocalStore()` so the inbox stays accurate even after disconnections.

## End-to-end diagram

```
LLM (Claude / Codex / Gemini)
 │  message_client_session(clientId, message)
 ▼
McpAgentBridge.handleMessageClientSession                       (src/mcp/adapter.ts)
 │
 ├──▶ resolveClientSession()  ──HTTP GET /agents──▶  Registry
 │
 ├── deterministic conversationId  =  sha1(sorted([from, to]))
 │
 └──▶ ConversationService.startConversation                     (src/client/conversation-service.ts)
       └──▶ ChannelClientRuntime.sendMessage                    (src/client/channel-client-runtime.ts)
             └──▶ ChannelTransport.postChannelMessage           (src/client/channel-transport.ts)
                   ──HTTP POST /channel/messages──▶ RegistryServer
                                                       │
                              ┌────────────────────────┼────────────────────────┐
                              ▼                        ▼                        ▼
                    channelStore.createMessage   eventBus.broadcast      agentWsMap[toAgentId]
                    (SQLite persist)             (dashboard, observers)  .send(channel.message)
                                                                                │
                                                                                ▼
                                                                  Recipient ChannelClientRuntime
                                                                  .handleRawMessage(raw)
                                                                   └─ trackMessage / dedup
                                                                   └─ emit("channel.message")
                                                                       │
                                                                       ▼
                                                          McpAgentBridge.deliverChannelMessage
                                                           ├─ POST /channel/acks (delivered_to_bridge)
                                                           ├─ native: Claude inbox socket / Codex daemon turn/start
                                                           ├─ else profile.mapChannelMessage(...)
                                                           ├─ server.notification(...)
                                                           │   • Claude (legacy) → notifications/claude/channel
                                                           │   • Codex/Gemini → notifications/message
                                                           └─ POST /channel/acks (displayed_to_client)
                                                                                │
                                                                                ▼
                                                                     Recipient LLM sees the inbox
                                                                     entry and may invoke `reply`
                                                                     → POST /channel/messages back
                                                                     → ack `answered` unblocks the
                                                                       original sender's wait
```

## Source map

| Concern                          | File                                                   |
| -------------------------------- | ------------------------------------------------------ |
| MCP tools + handlers             | `src/mcp/adapter.ts`                                   |
| Conversation orchestration       | `src/client/conversation-service.ts`                   |
| Runtime + WS event loop          | `src/client/channel-client-runtime.ts`                 |
| Local state store                | `src/client/conversation-session-store.ts`             |
| HTTP / WS transport              | `src/client/channel-transport.ts`                      |
| Registry HTTP API + WS broadcast | `src/registry/server.ts`                               |
| SQLite persistence               | `src/registry/channel-store.ts`                        |
| Event types                      | `src/registry/events.ts`                               |
| Per-client behavior              | `src/client/client-profile-resolver.ts` + `profiles/*` |
| Wire envelopes                   | `src/types/messages.ts`                                |

## Related docs

- [`architecture.md`](./architecture.md) — overall system architecture
- [`a2a-and-api.md`](./a2a-and-api.md) — A2A protocol surface for agent-to-agent calls
- [`cli-and-operations.md`](./cli-and-operations.md) — operating the registry, agents, and bridges
