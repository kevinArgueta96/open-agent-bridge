---
description: List the other local agent sessions you can message
disable-model-invocation: true
allowed-tools: mcp__open-agent-bridge__list_agents
---

Call `list_agents(includeClients=true)` and present the result as a short table:
session name, peer type, project path, and identity.

Rules:
- Do not call any other tool. Do not read files or run commands.
- Exclude the current session from the list; the user wants peers, not itself.
- Codex and Antigravity sessions register a `*-bridge-*` entry and a
  `*-mcp-client-*` entry that are the SAME agent. Show one row per agent.
- If nothing else is registered, say so plainly and mention that a peer only
  appears when it shares this session's channel identity.
