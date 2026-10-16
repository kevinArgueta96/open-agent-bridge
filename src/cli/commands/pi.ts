// `oab pi install-extension` — install the open-agent-bridge extension for pi.
// The extension registers our MCP server (the tools) and turns messages the
// adapter writes to its inbox socket into new turns. pi loads a single .ts file
// directly, so installing is just a copy.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The extension source, next to this command in both dist/ and src/ trees. */
function extensionSource(): string {
  const file = resolve(__dirname, "../../client/pi-extension/agent-bridge.ts");
  if (!existsSync(file)) throw new Error(`pi extension not found at ${file} — run \`pnpm build\` first`);
  return file;
}

export function registerPiCommand(program: Command): void {
  const pi = program.command("pi").description("pi-specific utilities");

  pi.command("install-extension")
    .description(
      "Install the open-agent-bridge extension for pi: exposes the bridge MCP tools and delivers " +
        "channel messages as a new turn in the live pi session",
    )
    .option("--project <path>", "Install into <path>/.pi/extensions/ (pi asks you to trust the project) instead of ~/.pi/agent/extensions/")
    .action((options: { project?: string }) => {
      const dir = options.project
        ? join(resolve(options.project), ".pi", "extensions")
        : join(homedir(), ".pi", "agent", "extensions");
      let source: string;
      try {
        source = extensionSource();
      } catch (err) {
        console.error(chalk.red("✗ ") + (err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, "open-agent-bridge.ts");
      copyFileSync(source, dest);
      console.log(chalk.green("✓") + ` pi extension installed at ${dest}`);
      console.log(chalk.dim("  Restart pi (or /reload). Incoming messages then arrive as a new turn."));
    });
}
