<template>
  <header class="app-header">
    <div class="app-brand">
      <div class="brand-mark">
        <div class="brand-mark-bars">
          <span />
          <span />
          <span />
        </div>
      </div>
      <div class="brand-copy">
        <span class="brand-title">open-agent-bridge</span>
        <span class="brand-subtitle">cockpit de agentes — qué están haciendo, en vivo</span>
      </div>
    </div>

    <nav class="app-nav">
      <RouterLink
        v-for="tab in tabs"
        :key="tab.to"
        :to="tab.to"
        class="nav-tab"
        :class="isActive(tab.to) ? 'nav-tab--active' : ''"
      >
        {{ tab.label }}
        <span v-if="tab.to === '/' && pendingReplies > 0" class="pending-badge">{{ pendingReplies }}</span>
      </RouterLink>
    </nav>

    <div class="app-status">
      <div class="select-wrap identity-select-wrap">
        <select v-model="identityModel" class="sig-select identity-select" title="Filtrar por canal (identity)">
          <option value="">todos los canales</option>
          <option v-for="id in identities" :key="id" :value="id">⛬ {{ id }}</option>
        </select>
        <span class="select-caret">▾</span>
      </div>

      <button
        v-if="notify.permission.value !== 'unsupported'"
        class="bell-btn"
        :class="{ 'bell-btn--on': notify.permission.value === 'granted' }"
        :title="bellTitle"
        @click="notify.enable()"
      >
        {{ notify.permission.value === 'granted' ? '🔔' : '🔕' }}
      </button>

      <div class="stat-chip registry-chip" :title="registryUrl">
        <span
          class="registry-dot"
          :class="{
            'pulse-healthy': status === 'connected',
            'pulse-working': status === 'connecting',
            'pulse-error': status === 'disconnected' || status === 'error',
          }"
          :style="{
            background: status === 'connected' ? 'var(--emerald)' :
                        status === 'connecting' ? 'var(--amber)' : 'var(--red)'
          }"
        />
        <span class="stat-label">registry</span>
        <span class="registry-status-label">{{ statusLabel }}</span>
      </div>
    </div>
  </header>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { useRegistryStore } from "@/stores/registry";
import { useCockpitStore } from "@/stores/cockpit";
import { useDeskNotifications } from "@/lib/notifications";

const route = useRoute();
const store = useRegistryStore();
const cockpit = useCockpitStore();
const notify = useDeskNotifications();

const tabs = [
  { to: "/", label: "cockpit" },
  { to: "/network", label: "red" },
];

function isActive(to: string): boolean {
  if (to === "/") return route.path === "/" || route.path.startsWith("/agents");
  return route.path === to;
}

const identities = computed(() => cockpit.identities);
const pendingReplies = computed(() => cockpit.metrics.pendingReplies);

const identityModel = computed<string>({
  get: () => cockpit.identityFilter ?? "",
  set: (v) => cockpit.setIdentityFilter(v || null),
});

const bellTitle = computed(() =>
  notify.permission.value === "granted"
    ? "Notificaciones activas"
    : "Activar notificaciones del navegador",
);

// Debounce "offline/error" by 2s to avoid flashing during brief WS reconnections.
const rawStatus = computed(() => store.status);
const status = ref(store.status);
let offlineTimer: ReturnType<typeof setTimeout> | null = null;

watch(rawStatus, (next) => {
  if (next === "connected" || next === "connecting") {
    if (offlineTimer) {
      clearTimeout(offlineTimer);
      offlineTimer = null;
    }
    status.value = next;
  } else {
    offlineTimer = setTimeout(() => {
      status.value = next;
      offlineTimer = null;
    }, 2000);
  }
});

const statusLabel = computed(
  () =>
    ({
      connected: "live",
      connecting: "connecting…",
      disconnected: "offline",
      error: "error",
    })[status.value] ?? status.value,
);

const registryUrl = computed(() => import.meta.env.VITE_REGISTRY_URL ?? "http://localhost:4999");
</script>

<style scoped>
.registry-chip {
  gap: 6px;
}
.registry-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
}
.registry-status-label {
  font-size: 0.78rem;
  font-weight: 700;
  color: var(--text-dim);
}
.identity-select-wrap {
  min-width: 168px;
}
.identity-select {
  min-height: 42px;
  padding: 0 32px 0 14px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 235, 219, 0.16);
  color: var(--text);
  font-size: 0.86rem;
  font-weight: 600;
}
.identity-select:focus {
  border-color: rgba(124, 229, 212, 0.5);
  box-shadow: 0 0 0 3px rgba(124, 229, 212, 0.16);
}
.identity-select option {
  color: #1f1713;
}
.identity-select-wrap .select-caret {
  color: var(--text-dim);
}
.bell-btn {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 999px;
  border: 1px solid rgba(255, 235, 219, 0.14);
  background: rgba(255, 255, 255, 0.03);
  font-size: 1rem;
}
.bell-btn--on {
  border-color: rgba(116, 227, 156, 0.4);
  background: rgba(116, 227, 156, 0.12);
}
.pending-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  background: var(--red);
  color: #fff;
  font-family: var(--font-mono);
  font-size: 0.6rem;
  border-radius: 999px;
  margin-left: 4px;
  font-weight: 700;
}
</style>
