// Build and write the .mcp.json entry that wires open-agent-bridge into an MCP
// client (Claude Code, etc.). Centralized here so `mcp config`, `init`, and the
// launchers all produce identical, correct configs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { resolveCliEntry, isOnPath } from "./runtime.js";

export const MCP_SERVER_NAME = "open-agent-bridge";

/** `linked` invokes the globally-installed binary by name (works after
 *  `npm i -g .` / `pnpm link --global`). `local` invokes node + the resolved
 *  dist path (works from a built checkout without a global install). */
export type McpConfigMode = "linked" | "local";

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface BuildMcpConfigOptions {
  projectPath?: string;
  identity?: string;
  mode?: McpConfigMode;
}

/** Prefer the linked global binary when it's on PATH; otherwise fall back to
 *  node + the local dist entry. */
export function defaultMcpMode(): McpConfigMode {
  return isOnPath("open-agent-bridge") || isOnPath("oab") ? "linked" : "local";
}

/** Name of the global binary to invoke in `linked` mode. */
function linkedBinaryName(): string {
  if (isOnPath("open-agent-bridge")) return "open-agent-bridge";
  if (isOnPath("oab")) return "oab";
  return "open-agent-bridge";
}

export function buildMcpServerEntry(opts: BuildMcpConfigOptions = {}): McpServerEntry {
  const projectPath = resolve(opts.projectPath ?? process.cwd());
  const mode = opts.mode ?? defaultMcpMode();

  const env: Record<string, string> = { AGENT_BRIDGE_PROJECT: projectPath };
  // Only bake in an identity when it's a real, non-default namespace — keeps the
  // common case clean (omitting it falls back to "global" at runtime).
  if (opts.identity && opts.identity !== "global") {
    env.AGENT_BRIDGE_IDENTITY = opts.identity;
  }

  if (mode === "linked") {
    return { command: linkedBinaryName(), args: ["mcp", "start"], env };
  }
  return { command: "node", args: [resolveCliEntry(), "mcp", "start"], env };
}

export function buildMcpConfig(opts: BuildMcpConfigOptions = {}): {
  mcpServers: Record<string, McpServerEntry>;
} {
  return { mcpServers: { [MCP_SERVER_NAME]: buildMcpServerEntry(opts) } };
}

/** Codex ignores .mcp.json — it only loads MCP servers from ~/.codex/config.toml.
 *  Rather than writing TOML ourselves, build the argv for the official
 *  `codex mcp add` CLI so Codex owns its own config format.
 *
 *  That file is GLOBAL, so AGENT_BRIDGE_PROJECT is left out: pinned there, every
 *  Codex session in any directory registered as the project `oab init` ran in.
 *  Codex starts the adapter in the session's cwd, which is the right project. */
export function buildCodexMcpAddArgs(entry: McpServerEntry): string[] {
  return [
    "mcp",
    "add",
    MCP_SERVER_NAME,
    ...Object.entries(entry.env)
      .filter(([k]) => k !== "AGENT_BRIDGE_PROJECT")
      .flatMap(([k, v]) => ["--env", `${k}=${v}`]),
    "--",
    entry.command,
    ...entry.args,
  ];
}

/**
 * Give the MCP client that runs *inside* Codex the same channel identity as the
 * bridge, by declaring it in the project-level `.codex/config.toml`.
 *
 * This is the Codex analogue of writing `.mcp.json` for Claude Code. It cannot
 * be done with an environment variable: Codex builds the environment of its MCP
 * servers from their declaration and does NOT pass its own through, so an
 * `AGENT_BRIDGE_IDENTITY` exported around `codex` never reaches them. Without
 * this the bridge sat in the requested namespace while the inner client stayed
 * in `global`, splitting the pair across the identity hard wall.
 *
 * Project-level, not `~/.codex/config.toml`: identity is a per-project choice,
 * and the user's global Codex config is not ours to rewrite on every launch.
 * Like `oab claude`, an existing declaration is left alone.
 */
export function writeCodexProjectConfig(
  projectPath: string,
  entry: McpServerEntry,
  serverName = MCP_SERVER_NAME,
): { path: string; written: boolean } {
  const path = resolve(projectPath, ".codex", "config.toml");
  const section = `[mcp_servers.${serverName}]`;
  const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";

  if (existing.includes(section)) return { path, written: false };

  const env = Object.entries(entry.env)
    .map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
    .join(", ");
  const block =
    `${section}\n` +
    `command = ${JSON.stringify(entry.command)}\n` +
    `args = [${entry.args.map((a) => JSON.stringify(a)).join(", ")}]\n` +
    (env ? `env = { ${env} }\n` : "");

  mkdirSync(dirname(path), { recursive: true });
  const separator = existing && !existing.endsWith("\n\n") ? (existing.endsWith("\n") ? "\n" : "\n\n") : "";
  writeFileSync(path, existing + separator + block, "utf-8");
  return { path, written: true };
}

interface McpConfigFile {
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Merge the open-agent-bridge entry into an existing .mcp.json without
 *  clobbering other MCP servers. Returns whether an existing file was merged. */
export function writeMcpConfig(targetPath: string, entry: McpServerEntry): { merged: boolean } {
  let root: McpConfigFile = {};
  let merged = false;

  if (existsSync(targetPath)) {
    try {
      root = JSON.parse(readFileSync(targetPath, "utf-8")) as McpConfigFile;
      merged = true;
    } catch {
      // Malformed JSON — overwrite rather than crash.
      root = {};
      merged = false;
    }
  }

  if (!root.mcpServers || typeof root.mcpServers !== "object") {
    root.mcpServers = {};
  }
  root.mcpServers[MCP_SERVER_NAME] = entry;

  writeFileSync(targetPath, JSON.stringify(root, null, 2) + "\n", "utf-8");
  return { merged };
}
