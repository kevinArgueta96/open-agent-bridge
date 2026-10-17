<template>
  <section v-if="items.length > 0" class="needs-you">
    <div class="needs-you__head">
      <span class="needs-you__label">Te necesitan</span>
      <span class="needs-you__count">{{ items.length }}</span>
    </div>
    <div class="needs-you__list">
      <button
        v-for="c in items"
        :key="c.conversationId"
        class="needs-item"
        @click="$emit('open', c.conversationId)"
      >
        <div class="needs-item__head">
          <span class="needs-item__from">{{ senderName(c) }}</span>
          <span class="needs-item__time">{{ relTime(c.lastMessage.createdAt) }}</span>
        </div>
        <p class="needs-item__preview">{{ preview(c.lastMessage.content) }}</p>
        <span class="needs-item__cta">abrir hilo →</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from "vue";
import { useCockpitStore } from "@/stores/cockpit";
import { formatRelativeTime } from "@/lib/utils";
import type { ChannelConversationListEntry } from "@/types";

defineEmits<{ open: [conversationId: string] }>();

const cockpit = useCockpitStore();
const items = computed(() => cockpit.needsYou);

function senderName(c: ChannelConversationListEntry): string {
  return c.lastMessage.fromAgentName || c.lastMessage.fromAgentId || "agente";
}
function relTime(ts: number): string {
  return formatRelativeTime(ts);
}
function preview(content: string): string {
  const clean = (content ?? "").replace(/\s+/g, " ").trim();
  return clean.length > 160 ? `${clean.slice(0, 160)}…` : clean;
}
</script>

<style scoped>
.needs-you {
  margin: 0 18px 16px;
  border-radius: var(--radius-lg);
  border: 1px solid rgba(255, 140, 124, 0.34);
  background: rgba(255, 140, 124, 0.08);
  overflow: hidden;
}
.needs-you__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid rgba(255, 140, 124, 0.2);
}
.needs-you__label {
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #8f3427;
}
.needs-you__count {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--red);
  color: #fff;
  font-size: 0.74rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.needs-you__list {
  display: flex;
  flex-direction: column;
}
.needs-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  text-align: left;
  padding: 12px 16px;
  border: 0;
  border-top: 1px solid rgba(255, 140, 124, 0.14);
  background: transparent;
  transition: background 0.18s ease;
}
.needs-item:first-child {
  border-top: 0;
}
.needs-item:hover {
  background: rgba(255, 140, 124, 0.1);
}
.needs-item__head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.needs-item__from {
  font-weight: 800;
  color: var(--text-ink);
}
.needs-item__time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: rgba(39, 29, 25, 0.5);
}
.needs-item__preview {
  margin: 0;
  font-size: 0.9rem;
  line-height: 1.5;
  color: rgba(39, 29, 25, 0.72);
}
.needs-item__cta {
  font-size: 0.74rem;
  font-weight: 800;
  color: #8f3427;
}
</style>
