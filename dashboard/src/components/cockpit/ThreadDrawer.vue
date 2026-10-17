<template>
  <Teleport to="body">
    <Transition name="drawer">
      <div v-if="conversationId" class="drawer-overlay" @click.self="close">
        <aside class="drawer">
          <header class="drawer__head">
            <div class="drawer__heading">
              <p class="drawer__title">Conversación</p>
              <p class="drawer__sub">{{ conversationId }}</p>
            </div>
            <button class="btn-ghost" @click="close">cerrar ✕</button>
          </header>

          <div ref="bodyEl" class="drawer__body scrollable">
            <div v-if="loading && messages.length === 0" class="drawer__loading">
              <span class="history-spinner" />
              <span>Cargando hilo…</span>
            </div>
            <div v-else-if="error" class="error-banner">{{ error }}</div>
            <div v-else-if="messages.length === 0" class="empty-state">
              <div class="empty-state__icon">✦</div>
              <p class="empty-state__title">Hilo vacío</p>
            </div>
            <ChatMessage v-for="m in messages" :key="m.id" :message="m" />
          </div>

          <footer class="drawer__composer">
            <div v-if="!replyTarget" class="drawer__hint">
              No hay un peer al que responder en este hilo.
            </div>
            <div v-else class="chat-input">
              <textarea
                v-model="draft"
                class="chat-textarea"
                :placeholder="`Responder a ${replyTarget.fromAgentName || replyTarget.fromAgentId}…`"
                rows="2"
                @keydown.enter.exact.prevent="send"
              />
              <button
                class="chat-send"
                :class="{ 'chat-send--on': canSend }"
                :disabled="!canSend"
                title="Enviar (Enter)"
                @click="send"
              >
                ➤
              </button>
            </div>
          </footer>
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick, onUnmounted } from "vue";
import ChatMessage from "@/components/chat/ChatMessage.vue";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import { fetchChannelConversation } from "@/lib/registry-client";
import type {
  ChannelConversationSnapshot,
  ChannelDeliveryState,
  ChannelMessagePayload,
  ChatMessage as ChatMessageT,
  WsMessage,
} from "@/types";

const props = defineProps<{ conversationId: string | null }>();
const emit = defineEmits<{ close: [] }>();

const snapshot = ref<ChannelConversationSnapshot | null>(null);
const loading = ref(false);
const error = ref<string | null>(null);
const draft = ref("");
const sending = ref(false);
const bodyEl = ref<HTMLElement | null>(null);

const selfId = dashboardChannelRuntime.clientId;

async function load(): Promise<void> {
  const id = props.conversationId;
  if (!id) return;
  loading.value = true;
  try {
    snapshot.value = await fetchChannelConversation(id);
    error.value = null;
    await nextTick();
    if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

// Latest delivery state per message, derived from the ack log.
const ackByMessage = computed(() => {
  const map = new Map<string, { state: ChannelDeliveryState; ts: number }>();
  for (const a of snapshot.value?.acknowledgements ?? []) {
    const prev = map.get(a.messageId);
    if (!prev || a.timestamp >= prev.ts) map.set(a.messageId, { state: a.state, ts: a.timestamp });
  }
  return map;
});

const messages = computed<ChatMessageT[]>(() =>
  (snapshot.value?.messages ?? [])
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((m) => ({
      id: m.messageId,
      role: m.fromAgentId === selfId ? "user" : "agent",
      content: m.content,
      timestamp: new Date(m.createdAt).toISOString(),
      messageId: m.messageId,
      conversationId: m.conversationId,
      deliveryState: ackByMessage.value.get(m.messageId)?.state,
    })),
);

// Reply to the most recent message that wasn't sent by the dashboard.
const replyTarget = computed<ChannelMessagePayload | null>(() => {
  const msgs = (snapshot.value?.messages ?? []).filter((m) => m.fromAgentId !== selfId);
  if (msgs.length === 0) return null;
  return msgs.reduce((latest, m) => (m.createdAt > latest.createdAt ? m : latest));
});

const canSend = computed(() => !!replyTarget.value && draft.value.trim().length > 0 && !sending.value);

async function send(): Promise<void> {
  if (!canSend.value || !props.conversationId || !replyTarget.value) return;
  sending.value = true;
  try {
    await dashboardChannelRuntime.sendMessage({
      conversationId: props.conversationId,
      replyTo: replyTarget.value.messageId,
      toAgentId: replyTarget.value.fromAgentId,
      content: draft.value.trim(),
      expectsResponse: false,
    });
    draft.value = "";
    setTimeout(() => void load(), 300);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    sending.value = false;
  }
}

function close(): void {
  emit("close");
}

// Refresh the open thread when its conversation gets new traffic.
const unsubscribe = dashboardChannelRuntime.on("registry", (msg: WsMessage) => {
  if (!props.conversationId) return;
  if (
    (msg.type === "channel.message" || msg.type === "channel.ack") &&
    msg.data.conversationId === props.conversationId
  ) {
    void load();
  }
});

watch(
  () => props.conversationId,
  (id) => {
    snapshot.value = null;
    error.value = null;
    draft.value = "";
    if (id) void load();
  },
  { immediate: true },
);

onUnmounted(() => unsubscribe());
</script>

<style scoped>
.drawer-overlay {
  position: fixed;
  inset: 0;
  z-index: 1200;
  display: flex;
  justify-content: flex-end;
  background: rgba(20, 14, 10, 0.42);
  backdrop-filter: blur(3px);
}
.drawer {
  display: flex;
  flex-direction: column;
  width: min(520px, 100vw);
  height: 100%;
  background: rgba(249, 243, 235, 0.98);
  border-left: 1px solid rgba(72, 55, 46, 0.18);
  box-shadow: var(--shadow-lg);
}
.drawer__head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 18px 20px;
  border-bottom: 1px solid rgba(72, 55, 46, 0.12);
}
.drawer__heading {
  flex: 1;
  min-width: 0;
}
.drawer__title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 1.3rem;
  color: var(--surface-0);
}
.drawer__sub {
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: rgba(39, 29, 25, 0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.drawer__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 20px;
}
.drawer__loading {
  display: flex;
  align-items: center;
  gap: 10px;
  color: rgba(39, 29, 25, 0.6);
}
.history-spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(72, 55, 46, 0.2);
  border-top-color: var(--sky);
  animation: spin 0.7s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.drawer__composer {
  padding: 14px 16px;
  border-top: 1px solid rgba(72, 55, 46, 0.12);
  background: linear-gradient(180deg, rgba(38, 29, 24, 0.98), rgba(26, 20, 17, 0.98));
  border-radius: 0;
}
.drawer__hint {
  color: var(--text-dim);
  font-size: 0.86rem;
  text-align: center;
  padding: 6px;
}
.drawer-enter-active,
.drawer-leave-active {
  transition: opacity 0.22s ease;
}
.drawer-enter-active .drawer,
.drawer-leave-active .drawer {
  transition: transform 0.26s cubic-bezier(0.22, 1, 0.36, 1);
}
.drawer-enter-from,
.drawer-leave-to {
  opacity: 0;
}
.drawer-enter-from .drawer,
.drawer-leave-to .drawer {
  transform: translateX(100%);
}
</style>
