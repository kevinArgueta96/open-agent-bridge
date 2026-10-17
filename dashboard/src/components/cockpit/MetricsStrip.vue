<template>
  <div class="metrics-strip">
    <div class="metric-tile" :class="{ 'metric-tile--alert': m.pendingReplies > 0 }">
      <span class="metric-value">{{ m.pendingReplies }}</span>
      <span class="metric-label">esperando respuesta</span>
    </div>
    <div class="metric-tile">
      <span class="metric-value">{{ m.healthy }}<span class="metric-of">/{{ m.agentsTotal }}</span></span>
      <span class="metric-label">peers en línea</span>
    </div>
    <div class="metric-tile">
      <span class="metric-value">{{ m.activeConvos }}</span>
      <span class="metric-label">conversaciones activas</span>
    </div>
    <div class="metric-tile">
      <span class="metric-value">{{ m.msgsPerMin }}</span>
      <span class="metric-label">mensajes / min</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useCockpitStore } from "@/stores/cockpit";

const cockpit = useCockpitStore();
const m = computed(() => cockpit.metrics);
</script>

<style scoped>
.metrics-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  padding: 18px 22px 4px;
}
.metric-tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border-radius: var(--radius-md);
  border: 1px solid rgba(72, 55, 46, 0.12);
  background: rgba(255, 251, 246, 0.62);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.45);
}
.metric-tile--alert {
  border-color: rgba(255, 140, 124, 0.4);
  background: rgba(255, 140, 124, 0.1);
}
.metric-value {
  font-family: var(--font-display);
  font-size: 1.85rem;
  line-height: 1;
  color: var(--surface-0);
  font-variant-numeric: tabular-nums;
}
.metric-of {
  font-size: 1.1rem;
  color: rgba(39, 29, 25, 0.4);
}
.metric-tile--alert .metric-value {
  color: #8f3427;
}
.metric-label {
  font-size: 0.76rem;
  font-weight: 800;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: rgba(39, 29, 25, 0.5);
}
@media (max-width: 1180px) {
  .metrics-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
