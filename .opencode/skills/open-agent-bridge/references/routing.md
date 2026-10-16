# Routing and Priority

## Target resolution in `message_client_session`

When you call `message_client_session`, the adapter resolves the best target in this order:

1. **`clientId` provided** — direct agentId lookup, no further resolution.
2. **No `clientId`, `conversationId` provided** — resolves from the conversation's participant history.
3. **`project` provided** — filters registered clients by project path/name substring.
4. **Multiple matches after filtering** — sorted by `CLIENT_PRIORITY`.

## CLIENT_PRIORITY array

```
Priority -1 (highest): bridge daemons
  clientVersion === "app-server-bridge"       (Codex, `oab codex start`)
  clientVersion === "opencode-plugin-bridge"  (legacy OpenCode 1 plugin)

Priority 0–N (by position):
  "claude-code", "claude", "opencode", "antigravity", "agy", "codex-cli", "codex"
  anything else (e.g. pi) sorts last
```

Bridge daemons win over inner MCP clients in the same project. Pass `clientId` (or `clientType`) to pick a specific session.

## Auto-redirect for inner clients

When a Codex session has an `oab codex start` bridge, sending to its inner client (`client-codex-mcp-client-*`) is redirected to the bridge for the same project. Without a bridge, the inner client is the target and the message starts a turn in the live TUI through Codex's app-server daemon.

Copy `replyWith.agentId` verbatim even if it looks like an inner client — the adapter handles the redirect.

## Conversation ID is deterministic

Every pair of agents shares a stable `conversationId`:

```
SHA1(sorted([agentIdA, agentIdB])).slice(0, 32) → formatted as UUID
```

This means:
- Both sides always land in the same thread without pre-coordination.
- `message_client_session` without a `conversationId` continues that thread; it does not open a new one.
- The ID is stable across registry restarts.
- If two agents initiate simultaneously, both messages arrive in the same thread.

## clientType filter

When a project has multiple sessions of different types, use `clientType` to disambiguate:

```
message_client_session(
  project: "my-project",
  clientType: "codex",   // "claude-code" | "opencode" | "codex" | "antigravity"
  message: "..."
)
```

`clientType` is ignored when `clientId` is set.

## WebSocket targeted delivery

When a message has `toAgentId`, the registry delivers it directly to that agent's WS connection before broadcasting to all subscribers. This means agents NOT in `toAgentId` may still see the broadcast but will not receive the targeted delivery event. The dashboard only updates on targeted delivery if its agentId matches `toAgentId` or if `toAgentId` is absent.
