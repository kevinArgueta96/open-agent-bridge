# Send and Reply Patterns

## Basic send

```
list_agents(includeClients: true)

message_client_session(
  clientId: "client-codex-bridge-abc123",
  message: "Review src/api/routes.ts for N+1 queries",
  expectsResponse: true
)
→ { conversationId: "conv-xyz", messageId: "msg-001", deliveryState: "queued" }
```

## Continuing a thread

Pass `conversationId` to append to an existing conversation instead of opening a new one:

```
message_client_session(
  clientId: "client-codex-bridge-abc123",
  conversationId: "conv-xyz",
  replyTo: "msg-002",
  message: "Follow-up: also check the auth middleware"
)
```

## Replying to an inbound message

An inbound message arrives as a new turn that already contains the filled-in `reply` call. Otherwise, find it in `channel_inbox`:

```
channel_inbox(pendingOnly: true)
→ entry.replyWith = {
    agentId:        "client-codex-bridge-abc123",
    conversationId: "conv-xyz",
    replyTo:        "msg-002"
  }

reply(
  agentId:        "client-codex-bridge-abc123",  // from replyWith — do not change
  conversationId: "conv-xyz",                     // from replyWith — do not change
  replyTo:        "msg-002",                       // from replyWith — do not change
  message:        "Thanks, applying fix now."
)
```

## Fire-and-forget (no reply expected)

```
message_client_session(
  project: "my-app",
  message: "Build finished. All tests passed. FYI",
  expectsResponse: false
)
```

Explicit `expectsResponse: false` suppresses the "reply required" injection prompt on the receiver's end. Alternatively, including FYI / no reply / sin respuesta in the message text infers the same behavior.

## Sending to a project when multiple clients are connected

```
message_client_session(
  project: "fit-mipyme-frontend",
  clientType: "codex",            // disambiguate: "claude-code" | "opencode" | "codex" | "antigravity"
  message: "Run the test suite"
)
```

## Routing shortcuts

| Goal | How |
|---|---|
| Send to Claude Code in a project | `project: "my-app", clientType: "claude-code"` |
| Send to an `oab codex start` bridge | Use any agentId of that Codex pair; the inner client is redirected |
| Reply to an inbound message | Always use `reply`, never `message_client_session` |
| Broadcast to all agents | Use CLI `broadcast` command or POST to each agentId manually |

## expectsResponse semantics

- If omitted, the adapter infers it from the message text (questions and review/confirm requests → `true`; FYI → `false`).
- The receiver's turn is headed "reply required" when `expectsResponse: true` and "informational (no reply)" when `false` — the same for every client.
- Only a Claude Code session on the legacy `<channel>` fallback gets a raw block and decides based on context.
- For deterministic behavior pass the flag explicitly; text inference is a convenience.
