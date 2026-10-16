import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";
import { appendOriginalRequest } from "../../client/antigravity-agents-file.js";
import {
  buildSessionStartHookOutput,
  buildStopHookOutput,
} from "../../client/antigravity-hooks.js";
import { collectPendingForClient } from "../../client/antigravity-pending.js";
import { AntigravityLsBridgeService } from "../../client/antigravity-ls-bridge-service.js";
import { lsTargetFromEnv, readAgyConversation, writeAgyConversation } from "../../client/antigravity-ls-client.js";
import { RegistryClient } from "../../client/registry-client.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Read all of stdin (hook event payload). Resolves "" if nothing is piped. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Emit the hook result as JSON on stdout (Antigravity parses stdout as JSON). */
function emitHookOutput(output: unknown): void {
  process.stdout.write(JSON.stringify(output));
}

interface HookPayload {
  conversationId?: string;
  workspacePaths?: string[];
}

function parseHookPayload(raw: string): HookPayload {
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return {};
  }
}

/** The agy process running this hook. agy runs hooks through `sh -c`, so skip shells. */
function agyPidOfHook(): number | undefined {
  let pid = process.ppid;
  for (let i = 0; i < 4 && pid > 1; i++) {
    const [ppid, comm = ""] = execFileSync("ps", ["-o", "ppid=,comm=", "-p", String(pid)], { encoding: "utf8" })
      .trim()
      .split(/\s+/, 2);
    if (!/^(sh|bash|dash|zsh|env)$/.test(basename(comm))) return pid;
    pid = Number(ppid);
  }
  return undefined;
}

/**
 * Hand this session's conversation to the MCP adapter, which then starts turns
 * in it while agy is idle. Only `attach` (run by agy's agent) sees the LS token;
 * hooks only see the conversation, so they refresh the one `attach` recorded —
 * that follows /new and resumes. Returns whether live delivery is on.
 */
function recordAgyConversation(payload: HookPayload): boolean {
  try {
    const agyPid = agyPidOfHook();
    const target = lsTargetFromEnv() ?? (agyPid ? readAgyConversation(agyPid) : undefined);
    const cascadeId = payload.conversationId ?? process.env.ANTIGRAVITY_CONVERSATION_ID;
    if (target?.csrf && cascadeId && agyPid) {
      writeAgyConversation(agyPid, { url: target.url, csrf: target.csrf, cascadeId });
      return true;
    }
    // agy logs hook stderr: say which piece is missing (names only, never values).
    const missing = [!target?.csrf && "LS address/token (run `open-agent-bridge antigravity attach` from agy)", !cascadeId && "conversation id", !agyPid && "agy pid"];
    console.error(`[antigravity] live delivery off — missing ${missing.filter(Boolean).join(", ")}`);
  } catch (err) {
    console.error("[antigravity] could not record the conversation:", err instanceof Error ? err.message : err);
  }
  return false;
}

async function resolveClientId(
  registry: RegistryClient,
  project: string,
  clientId?: string,
  identity?: string,
): Promise<string | undefined> {
  if (clientId) return clientId;
  // When an identity namespace is set, pick the project session whose identity
  // matches — otherwise distinct tickets in the same project would be confused.
  if (identity) {
    const agents = await registry.listAgents({ project });
    const wanted = identity;
    const match = agents.find(
      (a) => a.entryType === "client" && (a.identity ?? "global") === wanted,
    );
    if (match) return match.agentId;
  }
  const session = await registry.findClientSession({ project });
  return session?.agentId;
}

export function registerAntigravityCommand(program: Command): void {
  const antigravity = program
    .command("antigravity")
    .description("Antigravity CLI (`agy`) integration: native channels via MCP + hooks");

  // ── antigravity install-plugin ───────────────────────────────────────────────
  // The shared plugin (the one Claude Code and Codex install) also carries agy's
  // pieces: mcp_config.json, hooks.json (the hooks that hand the adapter agy's
  // live conversation) and the skill.
  antigravity
    .command("install-plugin")
    .description("Install the open-agent-bridge plugin into agy: MCP server, hooks for live delivery, and the skill")
    .action(() => {
      const pluginDir = resolve(__dirname, "../../../plugins/open-agent-bridge");
      if (!existsSync(join(pluginDir, "plugin.json"))) {
        console.error(chalk.red("✗") + ` plugin not found at ${pluginDir}`);
        process.exit(1);
      }
      try {
        execFileSync("agy", ["plugin", "install", pluginDir], { stdio: "inherit" });
      } catch {
        console.error(chalk.red("✗") + " `agy plugin install` failed — is agy ≥ 1.3 on PATH?");
        process.exit(1);
      }
      // Where the sidecar lived before plugins carried it; agy no longer loads it.
      rmSync(join(homedir(), ".gemini", "config", "sidecars", "open-agent-bridge"), { recursive: true, force: true });
      console.log(chalk.green("✓") + " open-agent-bridge plugin installed in agy — restart agy to load it.");
    });

  // ── antigravity attach ───────────────────────────────────────────────────────
  // agy gives its LS address and token to the commands its agent runs, not to
  // hooks or MCP servers — so the agent runs this once per conversation.
  antigravity
    .command("attach")
    .description("Run from inside agy (by its agent): let open-agent-bridge start turns in this conversation")
    .action(() => {
      if (recordAgyConversation({})) console.log("open-agent-bridge: live delivery on for this agy session.");
      else process.exitCode = 1;
    });

  // ── antigravity hook-stop ────────────────────────────────────────────────────
  antigravity
    .command("hook-stop")
    .description("Stop hook: deliver pending channel messages and force agy to continue")
    .option("--project <path>", "Workspace path (default: the hook's workspace)")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .option("--identity <id>", "Channel namespace to resolve the session for (default: global)")
    .action(async (options) => {
      const payload = parseHookPayload(await readStdin());
      recordAgyConversation(payload);
      // Plugin hooks run in the plugin's directory, not the workspace.
      const project: string = options.project ?? payload.workspacePaths?.[0] ?? process.cwd();
      try {
        const registry = new RegistryClient(options.registryUrl);
        const clientId = await resolveClientId(registry, project, options.clientId, options.identity);
        if (!clientId) {
          emitHookOutput({});
          return;
        }

        const pending = await collectPendingForClient(registry, clientId);
        for (const msg of pending) {
          appendOriginalRequest(project, {
            messageId: msg.messageId,
            fromAgentId: msg.fromAgentId,
            fromAgentName: msg.fromAgentName,
            conversationId: msg.conversationId,
            content: msg.content,
            timestampIso: new Date().toISOString(),
          });
        }

        emitHookOutput(buildStopHookOutput(pending));
      } catch (err) {
        console.error("[antigravity hook-stop]", err instanceof Error ? err.message : err);
        emitHookOutput({}); // never block the agent on a bridge error
      }
    });

  // ── antigravity hook-session-start ───────────────────────────────────────────
  antigravity
    .command("hook-session-start")
    .description("SessionStart hook: attach live delivery and surface pending channel messages")
    .option("--project <path>", "Workspace path (default: the hook's workspace)")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .option("--identity <id>", "Channel namespace to resolve the session for (default: global)")
    .action(async (options) => {
      const payload = parseHookPayload(await readStdin());
      const attached = recordAgyConversation(payload);
      const project: string = options.project ?? payload.workspacePaths?.[0] ?? process.cwd();
      let pending = 0;
      try {
        const registry = new RegistryClient(options.registryUrl);
        const clientId = await resolveClientId(registry, project, options.clientId, options.identity);
        if (clientId) pending = (await collectPendingForClient(registry, clientId)).length;
      } catch (err) {
        console.error("[antigravity hook-session-start]", err instanceof Error ? err.message : err);
      }
      emitHookOutput(buildSessionStartHookOutput(pending, { attached }));
    });

  // ── antigravity ls-push ──────────────────────────────────────────────────────
  antigravity
    .command("ls-push")
    .description(
      "Auto-deliver channel messages into a LIVE agy TUI via its Cascade Language " +
        "Server (SendUserCascadeMessage) — no tmux, no manual 'check inbox'. Requires " +
        "agy running with an open conversation in the workspace.",
    )
    .option("--project <path>", "Workspace path", process.cwd())
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--identity <id>", "Channel namespace of the agy session (default: global)")
    .option("--client-id <id>", "Explicit Antigravity client session ID")
    .option("--poll-interval-ms <n>", "Polling interval in ms", "2000")
    .option("--retry-interval-ms <n>", "Re-injection blackout per message in ms", "30000")
    .option("--once", "Run a single poll cycle and exit")
    .option("--verbose", "Verbose logs")
    .action(async (options) => {
      const service = new AntigravityLsBridgeService({
        projectPath: options.project,
        registryUrl: options.registryUrl,
        identity: options.identity,
        clientId: options.clientId,
        pollIntervalMs: Number(options.pollIntervalMs),
        retryIntervalMs: Number(options.retryIntervalMs),
        verbose: options.verbose ?? true,
      });
      if (options.once) {
        const n = await service.runOnce();
        console.error(`[antigravity ls-push] injected ${n} message(s)`);
        return;
      }
      console.error(
        chalk.green("✓") +
          ` Antigravity ls-push running (project: ${options.project}, identity: ${options.identity ?? "global"}). Ctrl-C to stop.`,
      );
      await service.start();
    });
}
