// open-agent-bridge list
import type { Command } from "commander";
import chalk from "chalk";
import { RegistryClient } from "../../client/registry-client.js";
import { getPeerType, getPeerTypeLabel } from "../../mcp/adapter.js";
import type { RegistryEntry } from "../../types/messages.js";

/** Bridge daemons are plumbing: each pairs 1:1 with the inner MCP client that
 *  already represents the same session, and delivery is redirected to them
 *  automatically. `list_agents` has always hidden them; the CLI used to print
 *  them, so a single Codex session looked like two peers. */
function isBridgeDaemon(entry: RegistryEntry): boolean {
  const peerType = getPeerType(entry);
  return peerType === "codex-bridge" || peerType === "opencode-bridge";
}

export function registerListCommand(program: Command): void {
  program
    .command("list")
    .description("List all active agents")
    .option("--skill <tag>", "Filter by skill tag")
    .option("--project <path>", "Filter by project name or path")
    .option("--raw", "Also show bridge daemons and other plumbing entries")
    .option("--json", "Output as JSON")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .action(async (options) => {
      const client = new RegistryClient(options.registryUrl);

      try {
        const all = await client.listAgents({
          skill: options.skill,
          project: options.project,
        });

        // --json stays raw: it is the machine-readable view, and tooling built
        // on it (prune, dashboards) reasons about real registry entries.
        if (options.json) {
          console.log(JSON.stringify(all, null, 2));
          return;
        }

        const hidden = options.raw ? [] : all.filter(isBridgeDaemon);
        const agents = options.raw ? all : all.filter((a) => !isBridgeDaemon(a));

        if (agents.length === 0) {
          console.log(chalk.yellow("No agents found"));
          if (hidden.length > 0) {
            console.log(chalk.dim(`  (${hidden.length} bridge daemon(s) hidden — use --raw to show them)`));
          }
          return;
        }

        console.log(chalk.bold(`\nActive agents (${agents.length})\n`));
        for (const agent of agents) {
          const health = agent.healthy ? chalk.green("● healthy") : chalk.red("● unhealthy");
          const label = getPeerTypeLabel(agent);
          console.log(`  ${health}  ${chalk.cyan(agent.name)}${label ? chalk.dim(`  [${label}]`) : ""}`);
          console.log(`    ID:      ${agent.agentId}`);
          if (agent.pid) console.log(`    PID:     ${agent.pid}${agent.host ? ` @ ${agent.host}` : ""}`);
          // Client sessions (MCP adapters) don't listen anywhere — port 0 is noise.
          if (agent.port) console.log(`    Port:    ${agent.port}`);
          console.log(`    Path:    ${agent.projectPath}`);
          console.log(`    Type:    ${agent.projectType}`);
          if (agent.identity) console.log(`    Identity: ${chalk.magenta(agent.identity)}`);
          const skills = agent.card.skills.map((s) => s.id).join(", ");
          if (skills) console.log(`    Skills:  ${skills}`);
          console.log();
        }

        if (hidden.length > 0) {
          console.log(
            chalk.dim(`  ${hidden.length} bridge daemon(s) hidden — they pair with the sessions above. Use --raw to show them.\n`),
          );
        }
      } catch {
        console.error(chalk.red("Error: Registry not available. Start it with: open-agent-bridge registry start"));
        process.exit(1);
      }
    });
}
