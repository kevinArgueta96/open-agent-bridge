<template>
  <div class="net-wrap">
    <div v-if="nodes.length === 0" class="empty-state">
      <div class="empty-state__icon">◌</div>
      <div>
        <p class="empty-state__title">Sin topología todavía</p>
        <p class="empty-state__body">
          Conectá dos o más agentes y, cuando se hablen por el canal, vas a ver acá quién
          habla con quién en vivo.
        </p>
      </div>
    </div>

    <svg v-else class="net-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet">
      <!-- edges -->
      <line
        v-for="e in edges"
        :key="e.key"
        :x1="pos(e.a).x" :y1="pos(e.a).y"
        :x2="pos(e.b).x" :y2="pos(e.b).y"
        class="net-edge"
        :class="{ 'net-edge--active': active.has(e.key) }"
        :stroke-width="active.has(e.key) ? 0.9 : 0.4"
      />
      <!-- nodes -->
      <g
        v-for="n in nodes"
        :key="n.id"
        class="net-node"
        :transform="`translate(${pos(n.id).x} ${pos(n.id).y})`"
      >
        <title>{{ n.label }} — {{ n.statusLabel }}</title>
        <circle r="3.4" :style="{ fill: n.accent }" :class="n.pulse" class="net-node__dot" />
        <text class="net-node__label" :y="labelOffset(n.id)" text-anchor="middle">
          {{ n.short }}
        </text>
      </g>
    </svg>

    <div class="net-legend">
      <span class="net-legend__item"><span class="net-dot" style="background: var(--emerald)" /> inactivo</span>
      <span class="net-legend__item"><span class="net-dot" style="background: var(--amber)" /> activo</span>
      <span class="net-legend__item"><span class="net-dot" style="background: var(--red)" /> espera respuesta</span>
      <span class="net-legend__item"><span class="net-dot" style="background: var(--text-ghost)" /> offline</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, onUnmounted } from "vue";
import { useCockpitStore } from "@/stores/cockpit";
import { useConversationsStore } from "@/stores/conversations";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import { clientLabel, peerAccent } from "@/lib/peers";
import type { AgentStatus } from "@/stores/cockpit";
import type { WsMessage } from "@/types";

const STATUS_ACCENT: Record<AgentStatus, string> = {
  idle: "var(--emerald)",
  active: "var(--amber)",
  waiting: "var(--red)",
  offline: "var(--text-ghost)",
};
const STATUS_LABEL: Record<AgentStatus, string> = {
  idle: "inactivo",
  active: "activo",
  waiting: "espera respuesta",
  offline: "offline",
};
const STATUS_PULSE: Record<AgentStatus, string> = {
  idle: "pulse-healthy",
  active: "pulse-working",
  waiting: "pulse-error",
  offline: "",
};

const cockpit = useCockpitStore();
const conversations = useConversationsStore();

interface Node {
  id: string;
  label: string;
  short: string;
  accent: string;
  pulse: string;
  statusLabel: string;
}

const nodes = computed<Node[]>(() =>
  cockpit.agentsWithStatus.map(({ agent, status }) => {
    const label =
      agent.projectName ||
      (agent.entryType === "client" ? clientLabel(agent.clientInfo?.clientName) : agent.name);
    return {
      id: agent.agentId,
      label,
      short: label.length > 12 ? `${label.slice(0, 12)}…` : label,
      accent: STATUS_ACCENT[status],
      pulse: STATUS_PULSE[status],
      statusLabel: STATUS_LABEL[status],
    };
  }),
);

const nodeIndex = computed(() => {
  const map = new Map<string, number>();
  nodes.value.forEach((n, i) => map.set(n.id, i));
  return map;
});

// Circular layout around the centre.
function pos(id: string): { x: number; y: number } {
  const count = nodes.value.length;
  const i = nodeIndex.value.get(id) ?? 0;
  if (count === 1) return { x: 50, y: 50 };
  const angle = (i / count) * Math.PI * 2 - Math.PI / 2;
  const radius = 36;
  return { x: 50 + radius * Math.cos(angle), y: 50 + radius * Math.sin(angle) };
}
function labelOffset(id: string): number {
  return pos(id).y < 50 ? -5 : 8.5;
}

interface Edge {
  key: string;
  a: string;
  b: string;
}

const edges = computed<Edge[]>(() => {
  const present = nodeIndex.value;
  const seen = new Map<string, Edge>();
  for (const c of conversations.list) {
    const from = c.lastMessage?.fromAgentId;
    const to = c.lastMessage?.toAgentId;
    if (!from || !to || from === to) continue;
    if (!present.has(from) || !present.has(to)) continue;
    const [a, b] = [from, to].sort();
    const key = `${a}|${b}`;
    if (!seen.has(key)) seen.set(key, { key, a, b });
  }
  return Array.from(seen.values());
});

// Edges that lit up recently from live traffic.
const active = reactive(new Set<string>());

const unsubscribe = dashboardChannelRuntime.on("registry", (msg: WsMessage) => {
  if (msg.type !== "channel.message") return;
  const from = msg.data.fromAgentId;
  const to = msg.data.toAgentId;
  if (!from || !to || from === to) return;
  const [a, b] = [from, to].sort();
  const key = `${a}|${b}`;
  active.add(key);
  setTimeout(() => active.delete(key), 1800);
});

onUnmounted(() => unsubscribe());
</script>

<style scoped>
.net-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 18px;
}
.net-svg {
  width: 100%;
  height: 100%;
  max-height: calc(100vh - 240px);
}
.net-edge {
  stroke: rgba(124, 229, 212, 0.28);
  transition: stroke 0.3s ease, stroke-width 0.3s ease;
}
.net-edge--active {
  stroke: var(--sky);
  filter: drop-shadow(0 0 1.5px rgba(124, 229, 212, 0.8));
  animation: net-flash 1.8s ease-out;
}
@keyframes net-flash {
  0% { stroke: #bafff0; stroke-width: 1.4; }
  100% { stroke: rgba(124, 229, 212, 0.28); }
}
.net-node__dot {
  stroke: rgba(255, 255, 255, 0.5);
  stroke-width: 0.4;
}
.net-node__label {
  font-family: var(--font-mono);
  font-size: 2.6px;
  fill: var(--text-ink);
  font-weight: 700;
}
.net-legend {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
  justify-content: center;
  padding: 8px 14px;
  border-radius: 999px;
  background: rgba(255, 251, 246, 0.7);
  border: 1px solid rgba(72, 55, 46, 0.12);
}
.net-legend__item {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.76rem;
  color: rgba(39, 29, 25, 0.62);
  font-weight: 600;
}
.net-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
}
</style>
