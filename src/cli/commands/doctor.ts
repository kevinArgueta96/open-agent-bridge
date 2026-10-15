// `oab doctor` — diagnose the open-agent-bridge environment without aborting on
// the first failure. Reports node version, PATH wiring, registry reachability,
// .mcp.json status, which client CLIs are available and whether their version
// gets native delivery into the live session, and Codex's MCP registration.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { isRegistryUp, whichBinary, DEFAULT_REGISTRY_URL } from "../lib/runtime.js";
import { MCP_SERVER_NAME } from "../lib/mcp-config.js";
import { claudeSupportsInboxSocket } from "../../client/claude-inbox-socket.js";
import { codexSupportsDaemon } from "../../client/codex-daemon-socket.js";

function versionOf(bin: string): string | null {
  try {
    return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return null;
  }
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** Optional checks render as a neutral marker (not a red failure) when missing. */
  optional?: boolean;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command("doctor")
    .description("Diagnose the open-agent-bridge environment (node, PATH, registry, .mcp.json, clients)")
    .option("--registry-url <url>", "Registry URL", DEFAULT_REGISTRY_URL)
    .option("--json", "Output checks as JSON")
    .action(async (options) => {
      const checks: Check[] = [];

      // Node version
      const major = Number(process.versions.node.split(".")[0]);
      checks.push({ name: "Node >= 22", ok: major >= 22, detail: `found v${process.versions.node}` });

      // CLI on PATH
      const cli = whichBinary("open-agent-bridge") ?? whichBinary("oab");
      checks.push({
        name: "oab / open-agent-bridge on PATH",
        ok: cli !== null,
        detail: cli ?? "not found — run `npm install -g .` from the repo, or add the bin dir to PATH",
      });

      // Registry
      const up = await isRegistryUp(options.registryUrl);
      checks.push({
        name: "Registry reachable",
        ok: up,
        detail: up ? options.registryUrl : `down (${options.registryUrl}) — run: oab up`,
      });

      // .mcp.json
      const mcpPath = resolve(".mcp.json");
      let mcpOk = false;
      let mcpDetail = "absent — run: oab init";
      if (existsSync(mcpPath)) {
        try {
          const cfg = JSON.parse(readFileSync(mcpPath, "utf-8")) as {
            mcpServers?: Record<string, { env?: Record<string, string> }>;
          };
          const entry = cfg.mcpServers?.[MCP_SERVER_NAME];
          if (entry) {
            mcpOk = true;
            mcpDetail = `present (identity: ${entry.env?.AGENT_BRIDGE_IDENTITY ?? "global"})`;
          } else {
            mcpDetail = "present but missing the open-agent-bridge entry — run: oab mcp config --write";
          }
        } catch {
          mcpDetail = "present but malformed JSON";
        }
      }
      checks.push({ name: ".mcp.json configured", ok: mcpOk, detail: mcpDetail });

      // Client CLIs (optional). Claude Code and Codex also report whether their
      // version gets messages as a new turn in the live session.
      for (const bin of ["claude", "codex", "opencode", "agy"]) {
        const path = whichBinary(bin);
        if (!path || (bin !== "claude" && bin !== "codex")) {
          checks.push({ name: `client: ${bin}`, ok: path !== null, detail: path ?? "not in PATH (optional)", optional: true });
          continue;
        }
        const version = versionOf(bin);
        const native = bin === "claude" ? claudeSupportsInboxSocket(version) : codexSupportsDaemon(version);
        const fallback =
          bin === "claude" ? "needs Claude Code ≥ 2.1.224 — use: oab claude --legacy-channels" : "needs codex ≥ 0.162 — use: oab codex start";
        checks.push({
          name: `client: ${bin} (native push)`,
          ok: native,
          detail: native ? `${version ?? path} — messages arrive as a new turn in the live session` : `${version} — ${fallback}`,
          optional: true,
        });
      }

      // Codex reads MCP servers from its own config, not .mcp.json.
      if (whichBinary("codex")) {
        const codexConfig = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml");
        const toml = existsSync(codexConfig) ? readFileSync(codexConfig, "utf-8") : "";
        const registered = toml.includes(`[mcp_servers.${MCP_SERVER_NAME}]`) || toml.includes('"oab@open-agent-bridge"');
        checks.push({
          name: "Codex MCP registered",
          ok: registered,
          detail: registered ? codexConfig : "missing — run: oab init --client codex (or install the oab plugin)",
          optional: true,
        });
        // Older `oab init` pinned the project in the GLOBAL config: every Codex
        // session then registered as that one project, wherever it ran.
        if (/AGENT_BRIDGE_PROJECT\s*=/.test(toml)) {
          checks.push({
            name: "Codex config not pinned to one project",
            ok: false,
            detail: `${codexConfig} sets AGENT_BRIDGE_PROJECT for every Codex session — run: oab init --client codex`,
          });
        }
      }

      if (options.json) {
        console.log(JSON.stringify(checks, null, 2));
        return;
      }

      console.log(chalk.bold("\nopen-agent-bridge doctor\n"));
      for (const c of checks) {
        const icon = c.ok ? chalk.green("✓") : c.optional ? chalk.yellow("○") : chalk.red("✗");
        console.log(`  ${icon} ${c.name} ${chalk.dim("— " + c.detail)}`);
      }

      const required = checks.filter((c) => !c.optional);
      const failed = required.filter((c) => !c.ok).length;
      console.log();
      if (failed === 0) {
        console.log(chalk.green("All required checks passed.") + chalk.dim("  Run `oab init` in a project to get started."));
      } else {
        console.log(chalk.red(`${failed} required check(s) failed.`) + chalk.dim(" See the hints above."));
      }
      console.log();
    });
}
