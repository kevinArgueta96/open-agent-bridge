// Desktop notifications driven by the registry's `claude.notify` event — the
// precise "an agent needs you" signal. Permission is requested explicitly from
// a header button (never auto-prompted), and notifications only fire once granted.
import { ref, onUnmounted } from "vue";
import { dashboardChannelRuntime } from "./channel-runtime";

type Permission = "default" | "granted" | "denied" | "unsupported";

export function useDeskNotifications() {
  const supported = typeof Notification !== "undefined";
  const permission = ref<Permission>(supported ? (Notification.permission as Permission) : "unsupported");

  async function enable(): Promise<void> {
    if (!supported) return;
    permission.value = (await Notification.requestPermission()) as Permission;
  }

  const unsubscribe = dashboardChannelRuntime.on("registry", (msg) => {
    if (msg.type !== "claude.notify") return;
    if (!supported || Notification.permission !== "granted") return;
    const d = msg.data;
    const body = typeof d.content === "string" && d.content.trim()
      ? d.content.slice(0, 140)
      : "Nueva solicitud en el canal";
    const n = new Notification(`${d.agentName || "Un agente"} te necesita`, {
      body,
      tag: d.conversationId ?? d.messageId ?? undefined,
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  });

  onUnmounted(() => unsubscribe());

  return { supported, permission, enable };
}
