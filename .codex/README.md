agent-bridge Codex bootstrap

Read `../PROJECT_MAP.md` first. It is the canonical quick-memory map for this repository.

This `.codex/` directory serves two roles:

- native Codex project configuration
- repo-local bootstrap notes for Codex workflows

Critical hotspots:

- `src/registry/server.ts`: central registry, channel persistence and WS events
- `src/agent/server.ts`: agent runtime, A2A/JSON-RPC, AG-UI SSE
- `src/agent/handlers.ts`: task routing and task lifecycle
- `src/mcp/adapter.ts`: MCP bridge, channel tools and per-client delivery (`deliverChannelMessage`)
- `src/client/codex-daemon-socket.ts`: native Codex delivery through the app-server daemon (codex ≥ 0.162)
- `src/client/codex-tmux-bridge-service.ts`: legacy tmux sidecar for older Codex

Current reality:

- local-first system on `localhost`
- registry agent state is in memory; channel conversations persist in SQLite under `~/.open-agent-bridge/`
- every client (Claude Code, Codex, OpenCode, pi, agy) receives a channel message as a new turn in its live session and answers with `reply`
- a plain `codex` (≥ 0.162) gets messages in the live TUI through its app-server daemon; `oab codex start` is for headless use or older Codex
