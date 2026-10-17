<template>
  <div class="app-shell">
    <AppHeader />
    <div class="app-frame net-frame">
      <div class="net-head">
        <span class="panel-label">Red de agentes</span>
        <span class="panel-sublabel">topología agente-a-agente en vivo</span>
      </div>
      <NetworkGraph />
    </div>
  </div>
</template>

<script setup lang="ts">
import AppHeader from "@/components/layout/AppHeader.vue";
import NetworkGraph from "@/components/network/NetworkGraph.vue";
</script>

<style scoped>
.net-frame {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 116px);
}
.net-head {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 18px 22px 6px;
}
</style>
