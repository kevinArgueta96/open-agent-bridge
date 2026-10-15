---
description: Send a message to another local agent session and report the delivery state
argument-hint: '<peer> <message>'
allowed-tools: mcp__open-agent-bridge__list_agents, mcp__open-agent-bridge__message_client_session, AskUserQuestion
---

Send a channel message to another local agent session.

Raw slash-command arguments: `$ARGUMENTS`

Steps:

1. Split the arguments into a peer hint (the first token) and the message (the
   rest). If the message is empty, ask the user what to send and stop.
2. Call `list_agents(includeClients=true)` to resolve the peer hint against
   session names and project paths.
   - Exactly one match → use it.
   - Several matches → use AskUserQuestion once to let the user pick.
   - No match → say so, list the available peers, and stop. Never guess an
     agentId or invent one.
3. Call `message_client_session` with the resolved peer and the message text.
   Pass the message through as the user wrote it; do not rewrite or summarise it.
4. Report the delivery state returned by the tool, in plain words:
   - `queued` / `delivered_to_bridge` — the peer's bridge has it but its agent
     has not surfaced it yet.
   - `displayed_to_client` — the peer's agent has seen it.
   - `answered` — the peer replied; show the reply verbatim.
   - `failed` — show the failure detail the tool returned.

Do not poll repeatedly waiting for a reply. If it has not been answered yet, say
so and tell the user the reply will arrive as a notification, or that they can
check with `/oab:inbox`.
