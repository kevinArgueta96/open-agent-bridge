<template>
  <RouterView />
</template>

<script setup lang="ts">
import { RouterView } from "vue-router";
import { onUnmounted } from "vue";
import { useRegistryStore } from "@/stores/registry";
import { useTraceStore } from "@/stores/trace";
import { useChatStore } from "@/stores/chat";
import { useConversationsStore } from "@/stores/conversations";
import { useCockpitStore } from "@/stores/cockpit";

const registryStore = useRegistryStore();
const traceStore = useTraceStore();
const chatStore = useChatStore();
// Instantiate cockpit data stores early so polling/derivation start on load.
const conversationsStore = useConversationsStore();
const cockpitStore = useCockpitStore();

onUnmounted(() => {
  registryStore.disconnect();
  traceStore.destroy();
  chatStore.destroy();
  conversationsStore.destroy();
  cockpitStore.destroy();
});
</script>
