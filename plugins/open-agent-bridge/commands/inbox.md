---
description: Show channel messages from other sessions that are waiting for your reply
argument-hint: '[--all]'
disable-model-invocation: true
allowed-tools: mcp__open-agent-bridge__channel_inbox, mcp__open-agent-bridge__reply, AskUserQuestion
---

Show the channel messages waiting on this session.

Raw slash-command arguments: `$ARGUMENTS`

1. Call `channel_inbox(pendingOnly=true)`, or `channel_inbox(pendingOnly=false)`
   when the arguments contain `--all`.
2. For each conversation, show who sent it, when, and the message text. Keep it
   scannable — one block per conversation, no invented summaries.
3. If nothing is pending, say so in one line and stop.
4. If exactly one message is pending, ask the user (AskUserQuestion) whether to
   reply now. If they answer with reply text, send it with `reply`, copying the
   `agentId`, `conversationId` and `replyTo` fields from that entry's
   `replyWith` block **verbatim** — never re-derive or substitute them, that is
   the usual cause of a lost reply.

Do not answer on the user's behalf without asking.
