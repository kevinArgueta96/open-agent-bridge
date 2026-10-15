import { randomUUID } from "node:crypto";
import type { AgentMessage, ChannelMessage } from "../../types/messages.js";
import type {
  AcceptsChannelMessageContext,
  ClientBehaviorProfile,
  ClientNotificationEnvelope,
  LegacyNotifyPayload,
} from "../client-profile-resolver.js";


function buildNotificationPayload(content: string, meta: Record<string, unknown>): ClientNotificationEnvelope {
  return {
    method: "notifications/message",
    params: {
      level: "info",
      logger: "open-agent-bridge.opencode",
      data: {
        content,
        meta,
      },
    },
  };
}

export class OpenCodeClientProfile implements ClientBehaviorProfile {
  readonly id: string = "opencode";
  readonly deliveryMode = "push" as const;

  acceptsChannelMessage(
    message: ChannelMessage,
    selfAgentId: string | null,
    ctx?: AcceptsChannelMessageContext,
  ): boolean {
    // Identity hard wall: a message is only visible inside its own namespace.
    if ((message.identity ?? "global") !== (ctx?.selfIdentity ?? "global")) return false;
    if (!message.toAgentId) return true;
    if (message.toAgentId === "opencode") return true;
    if (selfAgentId != null && message.toAgentId === selfAgentId) return true;
    // Auto-redirect rewrites toAgentId to the sibling plugin bridge. The inner
    // MCP client must still accept the message so the agent can discover it
    // via channel_inbox(pendingOnly=true).
    if (ctx?.siblingBridgeAgentIds?.has(message.toAgentId)) return true;
    return false;
  }

  mapChannelMessage(message: ChannelMessage): ClientNotificationEnvelope {
    return buildNotificationPayload(message.content, {
      from_agent: message.fromAgentId,
      ...(message.fromAgentName ? { agent_name: message.fromAgentName } : {}),
      conversation_id: message.conversationId,
      message_id: message.messageId,
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
      ...(message.taskId ? { task_id: message.taskId } : {}),
      kind: message.kind,
      ...message.meta,
    });
  }

  mapLegacyNotify(payload: LegacyNotifyPayload): ClientNotificationEnvelope {
    return buildNotificationPayload(payload.content, {
      ...(payload.agentId ? { from_agent: payload.agentId } : {}),
      ...(payload.agentName ? { agent_name: payload.agentName } : {}),
      conversation_id: payload.conversationId ?? randomUUID(),
      message_id: payload.messageId ?? randomUUID(),
      ...payload.meta,
    });
  }

  mapTaskRequestMessage(message: AgentMessage): ClientNotificationEnvelope | null {
    if (message.type !== "task.request") return null;
    const payload = message.payload as { message?: string; skillId?: string } | null;
    const rawMessage = payload?.message ?? "";
    const content = rawMessage || JSON.stringify(payload);
    return buildNotificationPayload(content, {
      from_agent: message.fromAgentId ?? "",
      task_id: message.taskId ?? "",
      ...(payload?.skillId ? { skill_id: payload.skillId } : {}),
    });
  }
}

/** pi talks to the bridge exactly like OpenCode: MCP tools from the adapter,
 *  turns from an in-process component (here a pi extension). */
export class PiClientProfile extends OpenCodeClientProfile {
  readonly id: string = "pi";
}
