// Shared types for the open-agent-bridge dashboard

export type AgentState = "healthy" | "unhealthy" | "unknown";
export type TaskState = "submitted" | "working" | "input-required" | "completed" | "failed" | "canceled";
export type ChannelDeliveryState = "queued" | "delivered_to_bridge" | "displayed_to_client" | "answered" | "failed";

export interface AgentSkill {
  id: string;
  name: string;
  description: string;
  tags: string[];
}

export interface AgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
    stateTransitionHistory: boolean;
  };
  skills: AgentSkill[];
}

export interface RegistryAgent {
  agentId: string;
  name: string;
  url: string;
  wsUrl: string;
  port: number;
  projectPath: string;
  projectName: string;
  projectType: "node" | "rust" | "go" | "python" | "java" | "unknown";
  card: AgentCard;
  registeredAt: number;
  lastHeartbeat: number;
  healthy: boolean;
  entryType?: "agent" | "client";
  /** Channel namespace this session belongs to. "global" (or undefined) is the
   *  default shared namespace; other values isolate the session to a ticket. */
  identity?: string;
  clientInfo?: {
    clientName: string;
    clientVersion: string;
  };
}

export type TraceEventKind = "task" | "ag-ui-step" | "ag-ui-tool" | "channel-message" | "channel-ack";

export interface TraceEvent {
  id: string;
  timestamp: string;
  agentId: string;
  agentName: string;
  taskId: string;
  state: TaskState;
  skillId?: string;
  duration?: number;
  payload?: unknown;
  expanded?: boolean;
  kind?: TraceEventKind;
  stepName?: string;
  toolCallName?: string;
  toolCallArgs?: unknown;
  clientId?: string;
  clientName?: string;
  clientLabel?: string;
  conversationId?: string;
  messageId?: string;
  replyTo?: string;
  direction?: "incoming" | "outgoing";
  channelState?: ChannelDeliveryState;
}

export interface ChatMessage {
  id: string;
  role: "user" | "agent" | "tool" | "system";
  content: string;
  timestamp: string;
  streaming?: boolean;
  messageId?: string;
  conversationId?: string;
  deliveryState?: ChannelDeliveryState;
  toolCall?: {
    name: string;
    args?: unknown;
    argsRaw?: string;
    result?: unknown;
    streaming?: boolean;
  };
}

// WebSocket messages from registry
export type WsMessage =
  | { type: "snapshot"; agents: RegistryAgent[] }
  | { type: "agent.registered"; timestamp: string; data: RegistryAgent }
  | { type: "agent.deregistered"; timestamp: string; data: { agentId: string } }
  | { type: "agent.heartbeat"; timestamp: string; data: { agentId: string; timestamp: number } }
  | { type: "agent.unhealthy"; timestamp: string; data: { agentId: string } }
  | { type: "agent.removed"; timestamp: string; data: { agentId: string } }
  | { type: "task.update"; timestamp: string; data: TaskUpdatePayload }
  | { type: "channel.message"; timestamp: string; data: ChannelMessagePayload }
  | { type: "channel.ack"; timestamp: string; data: ChannelAckPayload }
  | { type: "channel.conversation.suppressed"; timestamp: string; data: { conversationId: string } }
  | { type: "channel.conversation.revived"; timestamp: string; data: { conversationId: string } }
  | {
      type: "claude.notify";
      timestamp: string;
      data: {
        agentId: string;
        agentName?: string;
        content?: string;
        conversationId?: string;
        messageId?: string;
        meta?: Record<string, unknown>;
      };
    };

export interface TaskUpdatePayload {
  agentId: string;
  agentName: string;
  taskId: string;
  state: TaskState;
  skillId?: string;
  timestamp: string;
  payload?: unknown;
  clientId?: string;
  clientName?: string;
}

export interface ChannelMessagePayload {
  conversationId: string;
  messageId: string;
  replyTo?: string;
  fromAgentId: string;
  fromAgentName?: string;
  toAgentId?: string;
  taskId?: string;
  kind: string;
  content: string;
  meta?: Record<string, unknown>;
  createdAt: number;
  requiresAck?: boolean;
  expectsResponse?: boolean;
  expiresAt?: number;
  attemptCount?: number;
}

export interface ChannelAckPayload {
  conversationId: string;
  messageId: string;
  state: ChannelDeliveryState;
  actorId: string;
  actorType: "registry" | "bridge" | "client" | "agent";
  timestamp: number;
  detail?: string;
}

export interface ChannelConversationListEntry {
  conversationId: string;
  lastMessage: ChannelMessagePayload;
  pendingReply: boolean;
  expired: boolean;
  lastAckState?: ChannelDeliveryState;
  pendingCount?: number;
  pendingMessageIds?: string[];
  status?: "pending" | "expired" | "answered" | "failed" | "active";
}

export interface ChannelConversationSnapshot {
  conversationId: string;
  messages: ChannelMessagePayload[];
  acknowledgements: ChannelAckPayload[];
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "error";
