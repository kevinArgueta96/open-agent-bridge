<template>
  <div class="app-shell">
    <AppHeader />
    <div class="app-frame cockpit-frame">
      <MetricsStrip />

      <div class="cockpit-body">
        <section class="cockpit-col cockpit-col--agents">
          <NeedsYouTray @open="openThread" />

          <div class="cockpit-section-head">
            <span class="panel-label">Agentes</span>
            <span class="panel-count">{{ agents.length }}</span>
          </div>

          <div class="cockpit-scroll scrollable">
            <div v-if="agents.length === 0" class="empty-state">
              <div class="empty-state__icon">⬡</div>
              <div>
                <p class="empty-state__title">Sin peers conectados</p>
                <p class="empty-state__body">
                  Arrancá una sesión con <code>oab claude</code> o <code>oab up</code> y los
                  agentes aparecerán acá con su estado en vivo.
                </p>
              </div>
            </div>
            <TransitionGroup v-else tag="div" name="agent-fade" class="cockpit-cards">
              <AgentStatusCard
                v-for="a in agents"
                :key="a.agent.agentId"
                :data="a"
                @open="openAgentThread(a)"
              />
            </TransitionGroup>
          </div>
        </section>

        <section class="cockpit-col cockpit-col--stream">
          <div class="cockpit-section-head">
            <span class="panel-label">Actividad en vivo</span>
            <span class="panel-sublabel">mensajes del canal entre agentes</span>
          </div>
          <LiveStream @open="openThread" />
        </section>
      </div>
    </div>

    <ThreadDrawer :conversation-id="activeConversationId" @close="activeConversationId = null" />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, TransitionGroup } from "vue";
import AppHeader from "@/components/layout/AppHeader.vue";
import MetricsStrip from "@/components/cockpit/MetricsStrip.vue";
import NeedsYouTray from "@/components/cockpit/NeedsYouTray.vue";
import AgentStatusCard from "@/components/cockpit/AgentStatusCard.vue";
import LiveStream from "@/components/cockpit/LiveStream.vue";
import ThreadDrawer from "@/components/cockpit/ThreadDrawer.vue";
import { useCockpitStore } from "@/stores/cockpit";
import { useConversationsStore } from "@/stores/conversations";
import type { AgentWithStatus } from "@/stores/cockpit";

const cockpit = useCockpitStore();
const conversations = useConversationsStore();

const agents = computed(() => cockpit.agentsWithStatus);
const activeConversationId = ref<string | null>(null);

function openThread(conversationId: string): void {
  activeConversationId.value = conversationId;
}

// Clicking an agent jumps to the thread it owes a reply on, if any.
function openAgentThread(a: AgentWithStatus): void {
  const owed = cockpit.needsYou.find((c) => c.lastMessage?.toAgentId === a.agent.agentId);
  const any = owed
    ?? conversations.list.find(
      (c) =>
        c.lastMessage?.fromAgentId === a.agent.agentId ||
        c.lastMessage?.toAgentId === a.agent.agentId,
    );
  if (any) activeConversationId.value = any.conversationId;
}
</script>

<style scoped>
.cockpit-frame {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 116px);
}
.cockpit-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.1fr);
}
.cockpit-col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding-top: 8px;
}
.cockpit-col--agents {
  border-right: 1px solid rgba(72, 55, 46, 0.1);
}
.cockpit-section-head {
  display: flex;
  align-items: baseline;
  gap: 12px;
  padding: 12px 22px 10px;
}
.cockpit-scroll {
  flex: 1;
  min-height: 0;
}
.cockpit-cards {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 0 18px 18px;
}
.agent-fade-enter-active,
.agent-fade-leave-active {
  transition: all 0.3s ease;
}
.agent-fade-enter-from,
.agent-fade-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}
.agent-fade-move {
  transition: transform 0.3s ease;
}
@media (max-width: 1180px) {
  .cockpit-body {
    grid-template-columns: 1fr;
  }
  .cockpit-col--agents {
    border-right: 0;
    border-bottom: 1px solid rgba(72, 55, 46, 0.1);
  }
}
</style>
