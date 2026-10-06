---
name: agent-bridge
description: Use when sending or receiving messages between Claude Code, Codex, OpenCode, and Antigravity sessions via the open-agent-bridge MCP. Documents the workflow, peer-type semantics, send patterns, and how to verify a message reached the peer end-to-end. Load this skill before invoking `list_agents`, `message_client_session`, `channel_inbox`, or `reply` whenever you need more than the bare tool catalog from the MCP `instructions` block.
---

# Agent Bridge — coordination across Claude Code / Codex / OpenCode / Antigravity

The MCP server `open-agent-bridge` lets multiple AI CLIs (Claude Code, Codex, OpenCode, Antigravity) talk to each other through a shared registry. The protocol is built around **messages**: a sender posts a message addressed to a peer, the registry persists and broadcasts it, and the peer's runtime surfaces the message to its LLM.

The MCP `instructions` block intentionally lists only the four tools. Everything else — peer types, routing, troubleshooting — lives here.

## Tools (one-line recap)

| Tool | What it does |
|---|---|
| `list_agents(includeClients=true)` | Enumerates peers. Client-session rows include a peer-type label such as `[Claude Code]`, `[OpenCode]`, `[Codex inner]`, or `[Antigravity inner]`. |
| `message_client_session(clientId \| project, message)` | Opens a new conversation thread to a peer. |
| `channel_inbox(pendingOnly=true)` | Lists conversations that need attention, with a `replyWith` block per entry. |
| `reply(agentId, conversationId, replyTo, message)` | Responds to a pending message. Copy `replyWith` fields verbatim. |

## Peer types — what each client row in `list_agents` means

The adapter classifies every registry entry internally with a `peerType`. In the human-readable `list_agents` output, client-session rows render that classification as a label prefix such as `[Codex inner]`. In `channel_inbox`, the peer type is emitted as a structured `peerType` field.

| `peerType` | What it is | Send target? |
|---|---|---|
| `claude-code` | A Claude Code session. One entry per session. | ✅ direct |
| `codex-inner` | The MCP client running inside a Codex CLI session. | ✅ (auto-redirected) |
| `codex-bridge` | The Codex daemon that injects messages as new turns into Codex CLI. | ✅ direct (also the target after auto-redirect) |
| `antigravity-inner` | The MCP client running inside an Antigravity (`agy`) session. | ✅ (auto-redirected) |
| `antigravity-bridge` | The Antigravity Cascade Language Server daemon, analogous to `codex-bridge`. | ✅ direct |
| `dashboard-ui` | The local dashboard web UI. | ❌ never a send target |

**Pairing rule.** Codex and Antigravity sessions register **two** entries that share the same `projectPath`: `*-bridge-*` and `*-mcp-client-*`. Both represent the same agent. Either agentId works as a send target — the adapter auto-redirects `inner → bridge` so the daemon can inject a turn into the CLI. The human-readable `list_agents` summary hides bridge entries because they are plumbing and shows the inner client as the user-facing session.

## Send patterns

### Pattern A — open a brand-new thread

```text
1. list_agents(includeClients=true)        → pick the peer (look at the peer-type label)
2. message_client_session(
     clientId | project: <pick from step 1>,
     message: "...")
3. (optional) wait for ack states (see §Verification)
```

Routing notes:
- **To a Claude Code peer**: the message is injected as a new turn through Claude Code's native inbox socket (cross-session messaging, CC ≥ 2.1.224), even if that session is idle; older sessions launched with the legacy channels flag get a `<channel>` push event instead.
- **To a Codex/Antigravity peer**: the bridge daemon injects the content as a fresh turn into the CLI. *Simultaneously* the inner client surfaces the message in its own `channel_inbox(pendingOnly=true)` so the agent can poll it on the next tool call.
- If you need an answer, make that explicit in the message or pass `expectsResponse=true`. If the message is informational, pass `expectsResponse=false` or phrase it as no-response/FYI. When omitted, the adapter infers the flag from the text.

## Setting up Codex CLI with the bridge

For messages to reach the Codex TUI automatically, the Codex TUI must be attached to the app-server started by the bridge. Use either:

```text
open-agent-bridge codex start
```

or start the bridge daemon and attach Codex manually:

```text
open-agent-bridge codex app-bridge
codex --remote ws://127.0.0.1:4500
```

A plain `codex` invocation runs an isolated session. The bridge can still register, store messages, and let the inner MCP client show them in `channel_inbox`, but it cannot inject an automatic TUI turn into that isolated session. If delivery fails with detail `No Codex TUI attached to bridge app-server`, attach Codex with `codex --remote ws://127.0.0.1:<port>` or use `open-agent-bridge codex start`.

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

Never substitute or re-derive the agentId yourself — `replyWith.agentId` is already the right target (the bridge for Codex/Antigravity, the peer for Claude). Substituting it usually breaks delivery.

## Verification — ack states

When you send, the message walks through these states:

| State | Meaning |
|---|---|
| `queued` | Registry created the row. Not yet pushed. |
| `delivered_to_bridge` | The recipient bridge daemon received the WS event. **The peer LLM has not necessarily seen it yet.** |
| `displayed_to_client` | The message was submitted to the recipient client/runtime (`turn/start`, ACP prompt, or client push). |
| `answered` | The peer replied. |
| `failed` | Permanent delivery failure. |

**Common pitfall:** `delivered_to_bridge` ≠ "the peer read it". The Codex/Antigravity bridge daemon may be alive and acked the WS event but the agent could be mid-turn and have not processed the new injection. Wait for `displayed_to_client` or `answered` before declaring success.

`answered` is only expected when the original message requested a response (`expectsResponse=true`). For fire-and-forget messages, the bridges suppress captured agent output instead of sending a channel reply back to the sender.

## Troubleshooting

- **`channel_inbox(pendingOnly=true)` returns empty after a clear send**: confirm `dist/` is rebuilt (`pnpm build`) and that the recipient CLI has been restarted at least once since the build — the MCP `instructions` and skill catalogs are sent at handshake.
- **Message stuck on `delivered_to_bridge` for >30s**: call `channel_inbox` to inspect. If still no progress, the bridge daemon is offline, the Codex TUI is not attached with `--remote`, or the agent is in a long-running turn. Surface this to the user; do not silently retry.
- **Bridge is registered but not visible in `list_agents`**: this is expected in the human-readable summary. The send path can still route to it through the inner client by project or clientId, and `channel_inbox` preserves `originalFromAgentId` when a reply target was redirected.
- **Wrong peer type label**: the heuristic uses `clientName` and `clientVersion`. If a session registers with a non-canonical name (e.g. `codex-experiments`), the label still resolves correctly because `clientName.includes("codex")` covers it. Truly unknown clients show their raw `clientName`.

## Code touchpoints

- Filter that lets the inner client recognize an auto-redirected message: `src/client/profiles/{codex,antigravity}-client-profile.ts` (`acceptsChannelMessage`) + `src/mcp/adapter.ts` (`siblingBridgeAgentIds` + `refreshSiblingBridgeAgentIds`).
- Auto-redirect (inner → bridge) on the send path: `src/mcp/adapter.ts::resolveDeliverableTarget`.
- Peer-type classification: `src/mcp/adapter.ts::getPeerType` / `getPeerTypeLabel`.
- Bridge daemons (independent processes, not part of the MCP server): `src/client/codex-app-server-bridge.ts`, `src/client/antigravity-ls-bridge-service.ts`.
