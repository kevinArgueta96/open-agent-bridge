---
name: agent-bridge
description: Use when sending or receiving messages between Claude Code, Codex, OpenCode, pi, and Antigravity (agy) sessions via the open-agent-bridge MCP. Documents the workflow, peer-type semantics, send patterns, and how to verify a message reached the peer end-to-end. Load this skill before invoking `list_agents`, `message_client_session`, `channel_inbox`, or `reply` whenever you need more than the bare tool catalog from the MCP `instructions` block.
---

# Agent Bridge — coordination across Claude Code / Codex / OpenCode / pi / Antigravity

The MCP server `open-agent-bridge` lets multiple AI CLIs (Claude Code, Codex, OpenCode, pi, Antigravity `agy`) talk to each other through a shared registry. The protocol is built around **messages**: a sender posts a message addressed to a peer, the registry persists and broadcasts it, and the peer's runtime starts a **new turn** in its live session with that message. The peer answers with `reply`.

The MCP `instructions` block intentionally lists only the four tools. Everything else — peer types, routing, troubleshooting — lives here.

## Tools (one-line recap)

| Tool | What it does |
|---|---|
| `list_agents(includeClients=true)` | Enumerates peers. Client-session rows include a peer-type label such as `[Claude Code]`, `[Codex inner]`, `[OpenCode]`, `[pi]`, or `[Antigravity inner]`. |
| `message_client_session(clientId \| project, message)` | Sends a message to a peer. Each pair of agents shares one thread; a new message continues it. |
| `channel_inbox(pendingOnly=true)` | Lists conversations that need attention, with a `replyWith` block per entry. |
| `reply(agentId, conversationId, replyTo, message)` | Responds to a pending message. Copy `replyWith` fields verbatim. |

## Peer types — what each client row in `list_agents` means

The adapter classifies every registry entry internally with a `peerType`. In the human-readable `list_agents` output, client-session rows render that classification as a label prefix such as `[Codex inner]`. In `channel_inbox`, the peer type is emitted as a structured `peerType` field.

| `peerType` | Label | What it is | Send target? |
|---|---|---|---|
| `claude-code` | `[Claude Code]` | A Claude Code session. | ✅ direct |
| `codex-inner` | `[Codex inner]` | The MCP client inside a Codex CLI session. | ✅ direct (auto-redirected when an `oab codex start` bridge exists) |
| `codex-bridge` | `[Codex bridge]` | The `oab codex start` daemon that owns its own Codex thread. | ✅ direct |
| `opencode-code` | `[OpenCode]` | The MCP client inside an OpenCode session. | ✅ direct |
| `pi-code` | `[pi]` | The MCP client inside a pi session. | ✅ direct |
| `antigravity-inner` | `[Antigravity inner]` | The MCP client inside an `agy` session. | ✅ direct |
| `dashboard-ui` | `[Dashboard UI]` | The local dashboard web UI. | ❌ never a send target |

**Pairing rule.** Only a Codex session started with `oab codex start` registers **two** entries for the same `projectPath`: `*-bridge-*` and `*-mcp-client-*`. Either agentId works as a send target — the adapter auto-redirects `inner → bridge`. The human-readable `list_agents` summary hides bridge entries because they are plumbing.

## Send patterns

### Pattern A — send a message

```text
1. list_agents(includeClients=true)        → pick the peer (look at the peer-type label)
2. message_client_session(
     clientId | project: <pick from step 1>,
     message: "...")
3. (optional) wait for ack states (see §Verification)
```

Every target receives the message as a new turn in its live session, even when idle:
- **Claude Code** (≥ 2.1.224): through its native inbox socket. Older sessions launched with the legacy channels flag get a `<channel>` push event instead.
- **Codex** (≥ 0.162): through the app-server daemon into the user's live TUI; with `oab codex start` the bridge injects it into its own thread instead.
- **OpenCode** (plugin): queued in the session the user is working in. With the terminal on the home screen it goes to an `open-agent-bridge` session that OpenCode 2's terminal opens automatically.
- **pi** (extension): started as a follow-up turn.
- **Antigravity `agy`** (plugin): sent through agy's language server once the session ran `open-agent-bridge antigravity attach` (the plugin's SessionStart hook asks agy's agent to run it on the first turn). Before that, the Stop hook delivers it at the end of the next turn.

If you need an answer, make that explicit in the message or pass `expectsResponse=true`. If the message is informational, pass `expectsResponse=false` or phrase it as no-response/FYI. When omitted, the adapter infers the flag from the text.

## Setting up each client

| Client | One-time setup | Then run |
|---|---|---|
| Claude Code | `oab init` (writes `.mcp.json`) or the `oab` plugin | `claude` |
| Codex | `oab init --client codex` or the `oab` plugin | `codex` (≥ 0.162; older/headless: `oab codex start`) |
| OpenCode | `oab opencode install-plugin` (`--global` for all projects) | `opencode` |
| pi | `oab pi install-extension` (`--project` for `.pi/extensions/`) | `pi` |
| Antigravity | `oab antigravity install-plugin` (agy ≥ 1.3) | `agy` |

`open-agent-bridge doctor` checks native delivery for each installed client.

### Pattern B — reply to a pending message

```text
1. channel_inbox(pendingOnly=true)
2. for each conversation: read replyWith { agentId, conversationId, replyTo, peerType }
3. reply(
     agentId:        replyWith.agentId,        // verbatim
     conversationId: replyWith.conversationId, // verbatim
     replyTo:        replyWith.replyTo,        // verbatim
     message:        "<your response>")
```

A message that arrived as a new turn already includes this `reply` call with every field filled in. Never substitute or re-derive the agentId yourself — `replyWith.agentId` is already the right target. Substituting it usually breaks delivery.

## Verification — ack states

When you send, the message walks through these states:

| State | Meaning |
|---|---|
| `queued` | Registry created the row. Not yet pushed. |
| `delivered_to_bridge` | The recipient's adapter (or bridge daemon) received the WS event. **The peer LLM has not necessarily seen it yet.** |
| `displayed_to_client` | The message was handed to the recipient's live session (inbox socket, app-server turn, plugin, extension, or language server). |
| `answered` | The peer replied. |
| `failed` | Permanent delivery failure. |

**Common pitfall:** `delivered_to_bridge` ≠ "the peer read it". Wait for `displayed_to_client` or `answered` before declaring success. A delivery that fails on Codex, OpenCode, pi or Antigravity stays pending and is retried on the next registry sync; Claude Code falls back to the channel notification.

`answered` is only expected when the original message requested a response (`expectsResponse=true`). For fire-and-forget messages, the bridges suppress captured agent output instead of sending a channel reply back to the sender.

## Troubleshooting

- **`channel_inbox(pendingOnly=true)` returns empty after a clear send**: confirm `dist/` is rebuilt (`pnpm build`) and that the recipient CLI has been restarted at least once since the build — the MCP `instructions` and skill catalogs are sent at handshake.
- **Message stuck on `delivered_to_bridge`**: the recipient's in-host piece is missing or the agent is in a long-running turn. Run `open-agent-bridge doctor`: it flags a missing OpenCode plugin (or the old single-file one), pi extension, or agy plugin. For agy, check the session ran `open-agent-bridge antigravity attach`. Surface this to the user; do not silently retry.
- **Bridge is registered but not visible in `list_agents`**: expected in the human-readable summary. The send path can still route to it through the inner client by project or clientId, and `channel_inbox` preserves `originalFromAgentId` when a reply target was redirected.
- **Wrong peer type label**: the heuristic uses `clientName` and `clientVersion`. If a session registers with a non-canonical name (e.g. `codex-experiments`), the label still resolves correctly because `clientName.includes("codex")` covers it. Truly unknown clients show their raw `clientName`.

## Code touchpoints

- Delivery per client: `src/mcp/adapter.ts::deliverChannelMessage` — Claude inbox socket (`src/client/claude-inbox-socket.ts`), Codex daemon (`src/client/codex-daemon-socket.ts`), host inbox socket for OpenCode/pi (`src/client/host-inbox-socket.ts`), agy language server (`src/client/antigravity-ls-client.ts`).
- In-host pieces: `src/client/opencode-plugin/{agent-bridge,tui}.ts`, `src/client/pi-extension/agent-bridge.ts`, `plugins/open-agent-bridge/hooks.json` + `src/cli/commands/antigravity.ts` (`attach`, hooks).
- Auto-redirect (inner → bridge) on the send path: `src/mcp/adapter.ts::resolveDeliverableTarget`.
- Peer-type classification: `src/mcp/adapter.ts::getPeerType` / `getPeerTypeLabel`.
