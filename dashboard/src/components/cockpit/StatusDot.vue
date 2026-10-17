<template>
  <span
    class="status-dot"
    :class="meta.pulse"
    :style="{ background: meta.color }"
    :title="meta.label"
  />
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { AgentStatus } from "@/stores/cockpit";

const props = defineProps<{ status: AgentStatus }>();

const META: Record<AgentStatus, { color: string; pulse: string; label: string }> = {
  idle: { color: "var(--emerald)", pulse: "pulse-healthy", label: "Idle — connected" },
  active: { color: "var(--amber)", pulse: "pulse-working", label: "Active — recent activity" },
  waiting: { color: "var(--red)", pulse: "pulse-error", label: "Waiting for a reply" },
  offline: { color: "var(--text-ghost)", pulse: "", label: "Offline — unreachable" },
};

const meta = computed(() => META[props.status]);
</script>

<style scoped>
.status-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 999px;
  flex-shrink: 0;
}
</style>
