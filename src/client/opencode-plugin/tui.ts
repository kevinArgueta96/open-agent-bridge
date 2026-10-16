/**
 * open-agent-bridge terminal (CLI) plugin for OpenCode 2 — loaded automatically
 * next to the server plugin (`<plugins>/open-agent-bridge/{index,tui}.ts`).
 *
 * The server half queues each channel message as a prompt in a session, but
 * only the terminal knows which session is on screen. So when one arrives:
 * - on the home screen, open the session it went to;
 * - in another session, say where it went.
 */

const MARKER = "[open-agent-bridge] Channel message";

// biome-ignore lint/suspicious/noExplicitAny: OpenCode's CLI plugin context is not a dependency here
function setup(context: any): () => void {
  const here = () => (context.location ?? context.data.location.default())?.directory;
  // biome-ignore lint/suspicious/noExplicitAny: event shapes are not a dependency here
  return context.data.on("session.inbox.enqueued", (event: any, meta?: { directory?: string }) => {
    if (meta?.directory && meta.directory !== here()) return;
    const sessionID: string | undefined = event?.data?.sessionID;
    if (!sessionID || !JSON.stringify(event.data).includes(MARKER)) return;
    const current = context.ui.router.current();
    if (current?.type !== "session") {
      context.ui.router.navigate({ type: "session", sessionID });
    } else if (current.sessionID !== sessionID) {
      context.ui.toast.show({
        title: "open-agent-bridge",
        message: "A message from another agent arrived in another session.",
        variant: "info",
      });
    }
  });
}

export default { id: "open-agent-bridge.tui", setup };
