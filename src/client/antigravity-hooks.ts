/**
 * Pure builders for Antigravity CLI hook stdout payloads (agy ≥ 1.3 contract).
 *
 * Antigravity hooks read JSON from stdin and write JSON to stdout (camelCase).
 * - The `Stop` hook can return {"decision":"continue","reason":...} to keep the
 *   agent going with `reason` injected as a system message.
 * - The `SessionStart` hook can return `injectSteps` (system messages the model
 *   sees) without blocking.
 *
 * Keeping these pure makes the delivery decision testable in isolation from the
 * registry I/O performed by the CLI hook command.
 */

export interface PendingMessageSummary {
  fromAgentName?: string;
  fromAgentId?: string;
  content?: string;
  conversationId?: string;
}

export interface StopHookOutput {
  decision?: "continue";
  reason?: string;
}

export interface SessionStartHookOutput {
  injectSteps?: Array<{ systemMessage: { systemMessage: string } }>;
}

/**
 * Build the `Stop` hook output. When messages are pending, keep the agent going
 * and instruct it to read its inbox and reply. Empty object = allow stop.
 */
export function buildStopHookOutput(pending: PendingMessageSummary[]): StopHookOutput {
  if (pending.length === 0) return {};

  const senders = [
    ...new Set(pending.map((p) => p.fromAgentName ?? p.fromAgentId ?? "unknown")),
  ].join(", ");

  const reason =
    `You have ${pending.length} pending open-agent-bridge channel message(s) from: ${senders}. ` +
    "Do not stop yet. Call channel_inbox(pendingOnly=true) to read them, then answer each with the " +
    "reply tool. The latest message(s) were also appended to .agents/ORIGINAL_REQUEST.md.";

  return { decision: "continue", reason };
}

/**
 * Build the `SessionStart` hook output: ask the agent to attach this agy process
 * (only its own terminal gets the language-server token that live delivery
 * needs), and say when messages are already waiting.
 */
export function buildSessionStartHookOutput(
  pendingCount: number,
  { attached = true }: { attached?: boolean } = {},
): SessionStartHookOutput {
  const notes: string[] = [];
  if (!attached) {
    notes.push(
      "open-agent-bridge: before anything else, run `open-agent-bridge antigravity attach` in the terminal once. " +
        "It lets messages from the user's other agents reach this session as they arrive.",
    );
  }
  if (pendingCount > 0) {
    notes.push(
      `open-agent-bridge: ${pendingCount} pending channel message(s) for this session. ` +
        "Call channel_inbox(pendingOnly=true) to read and reply to them.",
    );
  }
  if (notes.length === 0) return {};
  return { injectSteps: notes.map((systemMessage) => ({ systemMessage: { systemMessage } })) };
}
