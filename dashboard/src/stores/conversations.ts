// Pinia store — channel conversations (inbox), driven by HTTP snapshots and
// patched by WebSocket channel.* events. Re-fetching on each channel event
// keeps the list correct without re-implementing the registry's pending/ack
// derivation on the client.
import { defineStore } from "pinia";
import { ref, computed } from "vue";
import { dashboardChannelRuntime } from "@/lib/channel-runtime";
import { fetchChannelConversations } from "@/lib/registry-client";
import type { ChannelConversationListEntry, WsMessage } from "@/types";

const POLL_INTERVAL_MS = 15_000;
const REFRESH_DEBOUNCE_MS = 400;

export const useConversationsStore = defineStore("conversations", () => {
  const list = ref<ChannelConversationListEntry[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastUpdatedAt = ref<number | null>(null);

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;
  let inFlight = false;

  async function refresh(): Promise<void> {
    if (inFlight) return;
    inFlight = true;
    if (list.value.length === 0) loading.value = true;
    try {
      list.value = await fetchChannelConversations();
      error.value = null;
      lastUpdatedAt.value = Date.now();
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    } finally {
      inFlight = false;
      loading.value = false;
    }
  }

  function scheduleRefresh(): void {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void refresh();
    }, REFRESH_DEBOUNCE_MS);
  }

  function handleRegistryMessage(msg: WsMessage): void {
    if (
      msg.type === "channel.message" ||
      msg.type === "channel.ack" ||
      msg.type === "channel.conversation.suppressed" ||
      msg.type === "channel.conversation.revived"
    ) {
      scheduleRefresh();
    }
  }

  // Conversations still awaiting a reply — the heart of the "needs you" tray.
  const pending = computed(() =>
    list.value.filter((c) => c.pendingReply && c.status !== "expired"),
  );

  // conversationId -> entry, for quick lookups from the stream/graph.
  const byId = computed(() => {
    const map = new Map<string, ChannelConversationListEntry>();
    for (const c of list.value) map.set(c.conversationId, c);
    return map;
  });

  function destroy(): void {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  // Subscribe to the shared runtime (no second WebSocket) and prime the list.
  unsubscribe = dashboardChannelRuntime.on("registry", (msg) => {
    try {
      handleRegistryMessage(msg);
    } catch (err) {
      console.warn("[conversations-store] error handling message:", err);
    }
  });
  void refresh();
  pollTimer = setInterval(() => void refresh(), POLL_INTERVAL_MS);

  return {
    list,
    pending,
    byId,
    loading,
    error,
    lastUpdatedAt,
    refresh,
    destroy,
  };
});
