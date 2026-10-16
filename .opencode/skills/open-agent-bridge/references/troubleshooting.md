# Troubleshooting

Start with `open-agent-bridge doctor`: it checks native delivery for every installed client (Claude Code and Codex versions, the OpenCode plugin, the pi extension, the agy plugin) and prints the fix for each failed check.

## `delivered_to_bridge` — stuck, no progress

The recipient's adapter received the message but could not hand it to the live session. On Codex, OpenCode, pi and Antigravity the message stays pending and is retried on the next registry sync.

**Claude Code:** needs ≥ 2.1.224 for the inbox socket. Older releases: launch with `open-agent-bridge claude --legacy-channels`.

**Codex:** needs codex ≥ 0.162 (app-server daemon). Headless or older Codex:
```bash
open-agent-bridge codex start --project /path/to/project
```

**OpenCode:** the plugin is missing or outdated. Install it and restart OpenCode:
```bash
open-agent-bridge opencode install-plugin   # --global for every project
```

**pi:** the extension is missing. Install it and restart pi (or `/reload`):
```bash
open-agent-bridge pi install-extension
```

**Antigravity (`agy`):** the plugin is missing, or the session has not run `attach` yet (the SessionStart hook asks agy's agent to run it on the first turn). Until then the Stop hook delivers pending messages at the end of each turn.
```bash
open-agent-bridge antigravity install-plugin   # then restart agy
open-agent-bridge antigravity attach           # run by agy's agent, from inside agy
```

---

## `displayed_to_client` — stuck at this state, no `answered`

The message started a turn in the recipient's session but the recipient has not replied yet. Wait for the turn to complete, or check that agent's terminal. A model that has no provider configured (for example pi before `/login`) receives the turn but cannot answer.

**OpenCode:** with the terminal on its home screen the message goes to an `open-agent-bridge` session. OpenCode 2's terminal opens it automatically; if you are in another session a toast says where it went.

---

## Registry not reachable

```
Error: fetch failed / ECONNREFUSED localhost:4999
```

The registry is not running.

Fix:
```bash
open-agent-bridge up
# or explicitly:
open-agent-bridge registry start
```

---

## `list_agents` returns empty or missing peers

The `AgentStore` is in-memory. After a registry restart, all registered agents must re-register. Adapters and bridges re-register automatically on reconnect. If a peer is missing, restart that agent.

---

## MCP tools not available in OpenCode

The plugin registers the MCP server itself. Reinstall it (`open-agent-bridge opencode install-plugin`) and restart OpenCode. On OpenCode 2 it lives in `.opencode/plugins/open-agent-bridge/{index.ts,tui.ts}` (or `~/.config/opencode/plugins/` with `--global`); no `opencode.json` edit is needed. A leftover single-file `agent-bridge.ts` is removed by the installer and flagged by `doctor`.

---

## WS reconnect / registry restart

Adapters and bridge daemons reconnect with exponential backoff and jitter. They also run a periodic re-sync that pulls missed messages from `/channel/conversations` and re-delivers them. The adapter skips ids it already delivered, and the OpenCode / pi listeners drop a repeated message id, so a re-sync does not start a second turn.

---

## Supercession (WS close code 4001)

When a new session registers with the same stable agentId hash, the registry closes the old WS connection with code 4001 (superceded). The old process detects this and stops. The new session takes over the agentId.

This is expected behavior when restarting an agent while the registry is running.

---

## Dashboard shows wrong conversation attribution

Known bug: when a channel message is broadcast without a `toAgentId`, the dashboard chat panel cannot attribute it to the correct conversation. Workaround: always set `toAgentId` when sending targeted messages. Fix tracked in `src/registry/server.ts` broadcast relay.
