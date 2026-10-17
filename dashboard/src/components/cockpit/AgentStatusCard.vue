<template>
  <div
    class="sig-card agent-card agent-status-card"
    :class="{ 'card--offline': data.status === 'offline' }"
    :style="{ '--card-accent': accent }"
    @click="$emit('open')"
  >
    <div class="agent-card__header">
      <StatusDot :status="data.status" />
      <span class="agent-card__name" :title="agent.projectPath">{{ displayName }}</span>
      <span class="chip" :class="badgeClass">{{ badge }}</span>
    </div>

    <div class="status-row">
      <span class="status-text" :class="`status-text--${data.status}`">{{ statusLabel }}</span>
      <span v-if="data.pendingCount > 0" class="pending-pill">
        {{ data.pendingCount }} pendiente{{ data.pendingCount > 1 ? "s" : "" }}
      </span>
      <span class="status-time">{{ activityLabel }}</span>
    </div>

    <div class="card-meta-row">
      <span v-if="identityLabel" class="chip chip-identity">⛬ {{ identityLabel }}</span>
      <span v-if="!isClient" class="chip chip-dim">:{{ agent.port }}</span>
      <RouterLink
        v-if="!isClient"
        :to="`/agents/${agent.agentId}`"
        class="detail-link"
        @click.stop
      >
        detalle →
      </RouterLink>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useTimeAgo } from "@vueuse/core";
import StatusDot from "./StatusDot.vue";
import { clientLabel, peerAccent } from "@/lib/peers";
import { projectTypeBadge } from "@/lib/utils";
import type { AgentWithStatus, AgentStatus } from "@/stores/cockpit";

const props = defineProps<{ data: AgentWithStatus }>();
defineEmits<{ open: [] }>();

const TYPE_CHIP: Record<string, string> = {
  node: "type-node", rust: "type-rust", go: "type-go",
  python: "type-python", java: "type-java", unknown: "type-unknown",
};
const STATUS_LABELS: Record<AgentStatus, string> = {
  idle: "Inactivo",
  active: "Activo",
  waiting: "Espera tu respuesta",
  offline: "Desconectado",
};

const agent = computed(() => props.data.agent);
const isClient = computed(() => agent.value.entryType === "client");
const displayName = computed(
  () => agent.value.projectName || (isClient.value ? clientLabel(agent.value.clientInfo?.clientName) : agent.value.name),
);
const badge = computed(() =>
  isClient.value ? clientLabel(agent.value.clientInfo?.clientName) : projectTypeBadge(agent.value.projectType),
);
const badgeClass = computed(() =>
  isClient.value ? "chip-violet" : (TYPE_CHIP[agent.value.projectType] ?? "type-unknown"),
);
const accent = computed(() =>
  isClient.value ? peerAccent(agent.value.clientInfo?.clientName) : "var(--emerald)",
);
const identityLabel = computed(() => {
  const id = agent.value.identity;
  return id && id !== "global" ? id : "";
});
const statusLabel = computed(() => STATUS_LABELS[props.data.status]);

const activityDate = computed(
  () => new Date(props.data.lastActivityAt ?? agent.value.lastHeartbeat ?? Date.now()),
);
const relative = useTimeAgo(activityDate);
const activityLabel = computed(() => relative.value);
</script>

<style scoped>
.agent-status-card {
  cursor: pointer;
}
.card--offline {
  opacity: 0.6;
}
.status-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.status-text {
  font-size: 0.84rem;
  font-weight: 800;
  letter-spacing: 0.04em;
}
.status-text--idle { color: var(--emerald); }
.status-text--active { color: var(--amber); }
.status-text--waiting { color: var(--red); }
.status-text--offline { color: var(--text-ghost); }
.status-time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.74rem;
  color: var(--text-dim);
}
.pending-pill {
  display: inline-flex;
  align-items: center;
  padding: 0 8px;
  min-height: 20px;
  border-radius: 999px;
  background: rgba(255, 140, 124, 0.16);
  border: 1px solid rgba(255, 140, 124, 0.36);
  color: #ffb1a4;
  font-size: 0.7rem;
  font-weight: 800;
}
.card-meta-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
</style>
