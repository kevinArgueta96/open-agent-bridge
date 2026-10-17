// Pinia store — the observational cockpit. Derives, from the registry +
// conversations + trace stores, everything the cockpit renders: per-agent live
// status, headline metrics, the "needs you" queue and the activity stream,
// all scoped by the selected channel identity. No backend changes required.
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { useRegistryStore } from "./registry";
import { useConversationsStore } from "./conversations";
import { useTraceStore } from "./trace";
import type { RegistryAgent, ChannelConversationListEntry, TraceEvent } from "@/types";

export type AgentStatus = "idle" | "active" | "waiting" | "offline";

export interface AgentWithStatus {
  agent: RegistryAgent;
  status: AgentStatus;
  /** Conversations where a message is directed at this agent awaiting its reply. */
  pendingCount: number;
  lastActivityAt: number | null;
}

// An agent counts as "active" while it has channel activity inside this window.
const ACTIVE_WINDOW_MS = 30_000;
const NOW_TICK_MS = 5_000;

export const useCockpitStore = defineStore("cockpit", () => {
  const registry = useRegistryStore();
  const conversations = useConversationsStore();
  const trace = useTraceStore();

  // null = all namespaces. Otherwise scope everything to one identity.
  const identityFilter = ref<string | null>(null);

  // Ticking clock so time-based status (active window) stays reactive.
  const now = ref(Date.now());
  const nowTimer = setInterval(() => {
    now.value = Date.now();
  }, NOW_TICK_MS);

  function agentIdentity(agentId?: string): string {
    if (!agentId) return "global";
    return registry.getAgent(agentId)?.identity || "global";
  }

  function matchesIdentity(identity?: string): boolean {
    if (!identityFilter.value) return true;
    return (identity || "global") === identityFilter.value;
  }

  function conversationMatchesIdentity(c: ChannelConversationListEntry): boolean {
    if (!identityFilter.value) return true;
    const from = agentIdentity(c.lastMessage?.fromAgentId);
    const to = agentIdentity(c.lastMessage?.toAgentId);
    return matchesIdentity(from) || matchesIdentity(to);
  }

  // Distinct namespaces present in the registry, "global" first.
  const identities = computed(() => {
    const set = new Set<string>();
    for (const a of registry.agentList) {
      if (a.agentId === registry.dashboardClientId) continue;
      set.add(a.identity || "global");
    }
    return Array.from(set).sort((a, b) =>
      a === "global" ? -1 : b === "global" ? 1 : a.localeCompare(b),
    );
  });

  // All registry entries except the dashboard itself, scoped by identity.
  const visibleAgents = computed(() =>
    registry.agentList.filter(
      (a) => a.agentId !== registry.dashboardClientId && matchesIdentity(a.identity),
    ),
  );

  function deriveStatus(agent: RegistryAgent): AgentWithStatus {
    if (!agent.healthy) {
      return { agent, status: "offline", pendingCount: 0, lastActivityAt: agent.lastHeartbeat ?? null };
    }
    let pendingCount = 0;
    let lastActivityAt: number | null = null;
    for (const c of conversations.list) {
      const m = c.lastMessage;
      if (!m) continue;
      const involved = m.fromAgentId === agent.agentId || m.toAgentId === agent.agentId;
      if (!involved) continue;
      if (typeof m.createdAt === "number") {
        lastActivityAt = lastActivityAt === null ? m.createdAt : Math.max(lastActivityAt, m.createdAt);
      }
      if (c.pendingReply && m.toAgentId === agent.agentId) pendingCount += 1;
    }
    if (pendingCount > 0) {
      return { agent, status: "waiting", pendingCount, lastActivityAt };
    }
    const active = lastActivityAt !== null && now.value - lastActivityAt < ACTIVE_WINDOW_MS;
    return { agent, status: active ? "active" : "idle", pendingCount: 0, lastActivityAt };
  }

  const agentsWithStatus = computed<AgentWithStatus[]>(() => {
    const order: Record<AgentStatus, number> = { waiting: 0, active: 1, idle: 2, offline: 3 };
    return visibleAgents.value
      .map(deriveStatus)
      .sort((a, b) => {
        if (order[a.status] !== order[b.status]) return order[a.status] - order[b.status];
        return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
      });
  });

  const clientAgents = computed(() =>
    agentsWithStatus.value.filter((a) => a.agent.entryType === "client"),
  );
  const runnableAgents = computed(() =>
    agentsWithStatus.value.filter((a) => a.agent.entryType !== "client"),
  );

  // Conversations still awaiting a reply, scoped by identity — the "needs you" tray.
  const needsYou = computed(() =>
    conversations.pending.filter(conversationMatchesIdentity),
  );

  // Activity feed: newest channel/task events, scoped by identity.
  const streamEvents = computed<TraceEvent[]>(() =>
    trace.events.filter((e) => matchesIdentity(agentIdentity(e.agentId))),
  );

  const metrics = computed(() => {
    const agents = visibleAgents.value;
    const cutoff = now.value - 60_000;
    const msgsPerMin = streamEvents.value.filter(
      (e) => e.kind === "channel-message" && new Date(e.timestamp).getTime() >= cutoff,
    ).length;
    const activeConvos = conversations.list.filter(
      (c) => conversationMatchesIdentity(c) && (c.status === "pending" || c.status === "active"),
    ).length;
    return {
      agentsTotal: agents.length,
      healthy: agents.filter((a) => a.healthy).length,
      clients: agents.filter((a) => a.entryType === "client").length,
      runnable: agents.filter((a) => a.entryType !== "client").length,
      waiting: agentsWithStatus.value.filter((a) => a.status === "waiting").length,
      pendingReplies: needsYou.value.length,
      msgsPerMin,
      activeConvos,
    };
  });

  function setIdentityFilter(identity: string | null): void {
    identityFilter.value = identity;
  }

  function destroy(): void {
    clearInterval(nowTimer);
  }

  return {
    identityFilter,
    identities,
    now,
    visibleAgents,
    agentsWithStatus,
    clientAgents,
    runnableAgents,
    needsYou,
    streamEvents,
    metrics,
    agentIdentity,
    setIdentityFilter,
    destroy,
  };
});
