// Peer-type presentation helpers, shared by the cockpit grid, the activity
// stream and the network graph so every surface labels and colours the same
// client type identically.

export const CLIENT_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  claude: "Claude",
  codex: "Codex CLI",
  "codex-cli": "Codex CLI",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  "gemini-cli": "Gemini CLI",
  gemini: "Gemini",
  cursor: "Cursor",
  copilot: "Copilot",
  dashboard: "Dashboard",
};

export function clientLabel(name?: string): string {
  if (!name) return "AI Client";
  return CLIENT_LABELS[name.toLowerCase()] ?? name;
}

// Accent colour per client type (CSS custom-property references from globals.css).
const PEER_ACCENT: Record<string, string> = {
  "claude-code": "var(--amber)",
  claude: "var(--amber)",
  codex: "var(--sky)",
  "codex-cli": "var(--sky)",
  opencode: "var(--violet)",
  antigravity: "var(--indigo)",
  "gemini-cli": "var(--emerald)",
  gemini: "var(--emerald)",
  cursor: "var(--blue)",
  copilot: "var(--sky)",
  dashboard: "var(--text-dim)",
};

export function peerAccent(name?: string): string {
  if (!name) return "var(--emerald)";
  return PEER_ACCENT[name.toLowerCase()] ?? "var(--text-dim)";
}
