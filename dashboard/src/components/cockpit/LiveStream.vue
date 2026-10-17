<template>
  <div class="live-stream">
    <div v-if="events.length === 0" class="empty-state">
      <div class="empty-state__icon">≈</div>
      <div>
        <p class="empty-state__title">Sin actividad todavía</p>
        <p class="empty-state__body">
          Cuando los agentes se manden mensajes por el canal, vas a verlos fluir acá en vivo.
        </p>
      </div>
    </div>

    <TransitionGroup v-else tag="div" name="stream" class="stream-list scrollable">
      <button
        v-for="e in events"
        :key="e.id"
        class="stream-row"
        :class="{ 'stream-row--clickable': !!e.conversationId }"
        :style="{ '--row-accent': accentFor(e) }"
        @click="e.conversationId && $emit('open', e.conversationId)"
      >
        <span class="stream-row__rail" />
        <div class="stream-row__body">
          <div class="stream-row__head">
            <span class="stream-row__from">{{ e.agentName }}</span>
            <span v-if="targetOf(e)" class="stream-row__arrow">→ {{ targetOf(e) }}</span>
            <span class="chip" :class="kindChip(e)">{{ kindLabel(e) }}</span>
            <span v-if="e.channelState" class="state-badge" :class="ackClass(e.channelState)">
              {{ e.channelState.replaceAll("_", " ") }}
            </span>
            <span class="stream-row__time">{{ time(e.timestamp) }}</span>
          </div>
          <p v-if="contentOf(e)" class="stream-row__preview">{{ contentOf(e) }}</p>
        </div>
      </button>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { computed, TransitionGroup } from "vue";
import { useCockpitStore } from "@/stores/cockpit";
import { formatTimestamp } from "@/lib/utils";
import { peerAccent } from "@/lib/peers";
import type { TraceEvent } from "@/types";

const MAX_ROWS = 80;

defineEmits<{ open: [conversationId: string] }>();

const cockpit = useCockpitStore();
const events = computed(() => cockpit.streamEvents.slice(0, MAX_ROWS));

function time(iso: string): string {
  return formatTimestamp(iso);
}
function contentOf(e: TraceEvent): string {
  const p = e.payload as { content?: unknown } | undefined;
  const raw = typeof p?.content === "string" ? p.content : "";
  const clean = raw.replace(/\s+/g, " ").trim();
  return clean.length > 200 ? `${clean.slice(0, 200)}…` : clean;
}
function targetOf(e: TraceEvent): string {
  return e.clientLabel || e.clientName || "";
}
function accentFor(e: TraceEvent): string {
  if (e.kind === "channel-ack") {
    return e.channelState === "failed" ? "var(--red)" : "var(--sky)";
  }
  return peerAccent(e.clientLabel);
}
function kindLabel(e: TraceEvent): string {
  switch (e.kind) {
    case "channel-message": return "mensaje";
    case "channel-ack": return "entrega";
    case "ag-ui-tool": return "tool";
    case "ag-ui-step": return "paso";
    default: return "tarea";
  }
}
function kindChip(e: TraceEvent): string {
  switch (e.kind) {
    case "channel-message": return "chip-cyan";
    case "channel-ack": return "chip-dim";
    default: return "chip-violet";
  }
}
function ackClass(state: string): string {
  switch (state) {
    case "answered": return "state-completed";
    case "failed": return "state-failed";
    case "displayed_to_client": return "state-input-required";
    default: return "state-working";
  }
}
</script>

<style scoped>
.live-stream {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.stream-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 0 18px 18px;
}
.stream-row {
  position: relative;
  display: flex;
  gap: 12px;
  width: 100%;
  text-align: left;
  padding: 12px 14px 12px 16px;
  border-radius: 16px;
  border: 1px solid rgba(72, 55, 46, 0.12);
  background: rgba(255, 251, 246, 0.64);
  overflow: hidden;
  transition: transform 0.18s ease, background 0.18s ease, border-color 0.18s ease;
}
.stream-row--clickable {
  cursor: pointer;
}
.stream-row--clickable:hover {
  transform: translateY(-1px);
  background: rgba(255, 255, 255, 0.82);
  border-color: rgba(72, 55, 46, 0.22);
}
.stream-row__rail {
  position: absolute;
  inset: 0 auto 0 0;
  width: 4px;
  background: var(--row-accent, var(--sky));
}
.stream-row__body {
  flex: 1;
  min-width: 0;
}
.stream-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.stream-row__from {
  font-weight: 800;
  color: var(--text-ink);
}
.stream-row__arrow {
  font-size: 0.82rem;
  color: rgba(39, 29, 25, 0.55);
}
.stream-row__time {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: rgba(39, 29, 25, 0.5);
}
.stream-row__preview {
  margin: 8px 0 0;
  font-size: 0.92rem;
  line-height: 1.55;
  color: rgba(39, 29, 25, 0.74);
  white-space: pre-wrap;
  word-break: break-word;
}
.stream-enter-active {
  animation: trace-slide-in 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.stream-move {
  transition: transform 0.3s ease;
}
</style>
