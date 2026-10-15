// `oab init` — one-command setup for a project. Interactive wizard by default,
// non-interactive with --yes (or when stdout/stdin isn't a TTY).
//
// Detects the project, picks an identity + clients, writes .mcp.json, brings the
// registry up as a background daemon, configures plugin-based clients, and prints
// tailored next steps. Replaces the user's `oab-mcp` shell alias and more.
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import * as p from "@clack/prompts";
import { ensureRegistry, resolveCliEntry, DEFAULT_REGISTRY_PORT } from "../lib/runtime.js";
import {
  buildMcpServerEntry,
  buildCodexMcpAddArgs,
  writeCodexProjectConfig,
  writeMcpConfig,
  defaultMcpMode,
  MCP_SERVER_NAME,
  type McpConfigMode,
} from "../lib/mcp-config.js";

function collectClient(value: string, prev: string[]): string[] {
  return [...prev, ...value.split(",").map((s) => s.trim()).filter(Boolean)];
}

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Set up open-agent-bridge for a project — writes .mcp.json, starts the registry, prints next steps")
    .option("--identity <id>", "Channel namespace (default: global)")
    .option("--client <name>", "Client to set up (claude|codex|opencode|antigravity); repeatable or comma-separated", collectClient, [])
    .option("--project <path>", "Project path (default: cwd)")
    .option("-p, --port <number>", "Registry port", String(DEFAULT_REGISTRY_PORT))
    .option("--mode <mode>", "MCP command mode: linked|local (default: auto)")
    .option("-y, --yes", "Non-interactive: use flags/defaults without prompting")
    .action(async (options) => {
      const projectPath = resolve(options.project ?? process.cwd());
      const port = Number(options.port);
      const interactive = !options.yes && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

      let identity: string = options.identity ?? "global";
      let clients: string[] = (options.client ?? []) as string[];
      const mode: McpConfigMode =
        options.mode === "local" ? "local" : options.mode === "linked" ? "linked" : defaultMcpMode();

      if (interactive) {
        p.intro(chalk.bold("open-agent-bridge · init"));
        p.log.info(`Project: ${chalk.cyan(projectPath)}`);
        const answers = await p.group(
          {
            identity: () =>
              p.text({
                message: "Channel identity (namespace) — sessions only see peers sharing it",
                placeholder: "global",
                defaultValue: "global",
                initialValue: options.identity ?? "",
              }),
            clients: () =>
              p.multiselect({
                message: "Which clients do you want to set up?",
                options: [
                  { value: "claude", label: "Claude Code" },
                  { value: "codex", label: "Codex" },
                  { value: "opencode", label: "OpenCode" },
                  { value: "antigravity", label: "Antigravity (agy)" },
                ],
                initialValues: clients.length ? clients : ["claude"],
                required: true,
              }),
          },
          {
            onCancel: () => {
              p.cancel("Cancelled.");
              process.exit(0);
            },
          },
        );
        identity = (answers.identity as string)?.trim() || "global";
        clients = answers.clients as string[];
      }

      if (clients.length === 0) clients = ["claude"];

      const ok = (msg: string) => (interactive ? p.log.success(msg) : console.log(chalk.green("✓") + " " + msg));
      const warn = (msg: string) => (interactive ? p.log.warn(msg) : console.warn(chalk.yellow("⚠") + " " + msg));
      const fail = (msg: string) => (interactive ? p.log.error(msg) : console.error(chalk.red("✗") + " " + msg));

      // 1. Write .mcp.json (Claude Code reads this directly).
      const entry = buildMcpServerEntry({ projectPath, identity, mode });
      const { merged } = writeMcpConfig(resolve(projectPath, ".mcp.json"), entry);
      ok(`.mcp.json ${merged ? "updated" : "written"} ${chalk.dim(`(mode: ${mode}, identity: ${identity})`)}`);

      // 2. Bring the registry up as a background daemon.
      try {
        const { started } = await ensureRegistry({ port, cwd: projectPath });
        ok(started ? `Registry started on :${port}` : `Registry already up on :${port}`);
      } catch (err) {
        fail("Could not start registry: " + (err instanceof Error ? err.message : String(err)));
      }

      // 3. Configure plugin-based clients by reusing their existing installers.
      for (const client of clients) {
        if (client === "codex") {
          // Codex ignores .mcp.json — register via its own CLI into ~/.codex/config.toml.
          try {
            // Remove-then-add keeps re-running init idempotent (add errors on duplicates).
            try {
              execFileSync("codex", ["mcp", "remove", MCP_SERVER_NAME], { stdio: "ignore" });
            } catch {
              // Not registered yet — fine.
            }
            execFileSync("codex", buildCodexMcpAddArgs(entry), { stdio: "inherit" });
            ok(`Codex MCP registered ${chalk.dim("(~/.codex/config.toml)")}`);
          } catch {
            warn(
              `Could not register with Codex — is \`codex\` on PATH? Run manually:\n  codex ${buildCodexMcpAddArgs(entry).map((a) => (a.includes(" ") ? JSON.stringify(a) : a)).join(" ")}`,
            );
          }
          // The global entry carries no identity (it would apply to every Codex
          // session); a project's namespace lives in its own .codex/config.toml.
          if (identity !== "global") {
            const { path, written } = writeCodexProjectConfig(projectPath, entry);
            if (written) ok(`Codex identity ${identity} declared ${chalk.dim(`(${path})`)}`);
            else warn(`${path} already declares ${MCP_SERVER_NAME} — left as is; check its AGENT_BRIDGE_IDENTITY`);
          }
        }
        if (client === "opencode" || client === "antigravity") {
          try {
            execFileSync(
              process.execPath,
              [resolveCliEntry(), client, "install-plugin", "--project", projectPath],
              { stdio: "inherit" },
            );
          } catch {
            warn(`Could not auto-configure ${client} — run \`oab ${client} install-plugin --project ${projectPath}\` manually`);
          }
        }
      }

      // 4. Tailored next steps. Both CLIs deliver natively now, so the plain
      // command is the whole setup; the identity already rides in the config.
      const idFlag = identity !== "global" ? ` --identity ${identity}` : "";
      const lines: string[] = [];
      if (clients.includes("claude"))
        lines.push(`Claude Code:  ${chalk.cyan("claude")}  ${chalk.dim("(Claude Code < 2.1.224: oab claude --legacy-channels)")}`);
      if (clients.includes("codex"))
        lines.push(`Codex:        ${chalk.cyan("codex")}   ${chalk.dim(`(codex < 0.162 or headless: oab codex start${idFlag})`)}`);
      if (clients.includes("opencode")) lines.push(`OpenCode:     ${chalk.dim("plugin installed — restart OpenCode")}`);
      if (clients.includes("antigravity")) lines.push(`Antigravity:  ${chalk.dim("MCP + hooks installed — restart agy")}`);
      lines.push(`Status:       ${chalk.cyan("oab status")}`);
      lines.push(`Stop hub:     ${chalk.cyan("oab down")}`);

      if (interactive) {
        p.note(lines.join("\n"), "Next steps");
        p.outro(chalk.green("Ready."));
      } else {
        console.log("\n" + chalk.bold("Next steps:"));
        for (const l of lines) console.log("  " + l);
        console.log();
      }
    });
}
