# Peer Types

Each registry entry is classified with a `peerType` (`src/mcp/adapter.ts::getPeerType`). Every client gets incoming messages as a new turn in its live session; what differs is the in-host piece that starts the turn.

## Taxonomy

| Peer type | Label | How a message starts a turn | Needs |
|---|---|---|---|
| `claude-code` | `[Claude Code]` | Claude Code's inbox socket (`$CLAUDE_CODE_MESSAGING_SOCKET`) | Claude Code ≥ 2.1.224 (older: `oab claude --legacy-channels`) |
| `codex-inner` | `[Codex inner]` | Codex app-server daemon, into the live TUI | codex ≥ 0.162 |
| `codex-bridge` | `[Codex bridge]` | `turn/start` into the bridge's own thread | `oab codex start` (headless / older Codex) |
| `opencode-code` | `[OpenCode]` | OpenCode plugin: host inbox socket → `session.prompt` (`delivery: "queue"`) | `oab opencode install-plugin` |
| `pi-code` | `[pi]` | pi extension: host inbox socket → `sendMessage` (follow-up turn) | `oab pi install-extension` |
| `antigravity-inner` | `[Antigravity inner]` | agy's language server, `SendUserCascadeMessage` (`WHEN_IDLE`) | `oab antigravity install-plugin` + a one-time `attach` |
| `opencode-bridge` | `[OpenCode bridge]` | Legacy: the old OpenCode 1 plugin registered itself as a bridge | — |
| `dashboard-ui` | `[Dashboard UI]` | WS event in the chat panel | — |
| `unknown` | raw `clientName` | Channel notification only | — |

## Notes

**Claude Code** gets the message as a `user` frame on its inbox socket, so an idle session starts a turn. If the socket is unavailable it falls back to the `<channel>` notification.

**Codex** (≥ 0.162) runs its TUI on a shared app-server daemon; the adapter starts a turn on the daemon's thread for this project. Only `oab codex start` adds a second entry (`codex-bridge`); sending to either agentId then routes to the bridge.

**OpenCode** registers one entry. Its plugin (`<plugins>/open-agent-bridge/index.ts`) queues each message in the session in use; with the terminal on its home screen it uses an `open-agent-bridge` session, and the terminal half (`tui.ts`, OpenCode 2) opens it.

**pi** registers one entry. Its extension starts the turn as a follow-up, so a running turn is not interrupted.

**Antigravity (`agy`)** registers one entry. The plugin's SessionStart hook asks agy's agent to run `open-agent-bridge antigravity attach` once, because only commands agy's agent runs receive the language-server token. Until then the Stop hook delivers pending messages at the end of each turn.

**Dashboard** is a passive listener. Never set it as the target of a `message_client_session` call.

## How to identify the peer type from `list_agents`

`list_agents(includeClients: true)` returns rows like:

```
[Claude Code]        another     [f3a4b5c6]
[Codex inner]        other-proj  [c9d0e1f2]
[OpenCode]           my-project  [a1b2c3d4]
[pi]                 my-project  [8530439a]
[Antigravity inner]  my-project  [1f1766de]
```

The bracket label is the human-readable peer type. The 8-char suffix is the last 8 chars of the agentId for disambiguation when multiple same-type sessions are visible.
