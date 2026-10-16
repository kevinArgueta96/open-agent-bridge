import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import chalk from "chalk";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Installed OpenCode's major version; 2 when it cannot be told (the current one). */
function openCodeMajor(): number {
  try {
    return Number(/(\d+)\./.exec(execFileSync("opencode", ["--version"], { encoding: "utf8" }))?.[1] ?? 2);
  } catch {
    return 2;
  }
}

/** Resolve the directory where the plugin source files live. Works for both
 *  the compiled dist/ tree and the raw src/ tree (ts-node / bun). */
function resolvePluginSourceDir(): string {
  // dist/cli/commands/ → ../../client/opencode-plugin/
  const fromDist = resolve(__dirname, "../../client/opencode-plugin");
  if (existsSync(join(fromDist, "agent-bridge.ts"))) return fromDist;

  // src/cli/commands/ → ../../client/opencode-plugin/
  const fromSrc = resolve(__dirname, "../../client/opencode-plugin");
  if (existsSync(join(fromSrc, "agent-bridge.ts"))) return fromSrc;

  throw new Error(
    "Could not locate opencode-plugin source directory. " +
      "Run `npm run build` first or check your installation.",
  );
}

// Local plugins in .opencode/plugins/ are auto-loaded by OpenCode without
// any entry in opencode.json. Only npm package plugins need to be listed.

export function registerOpenCodeCommand(program: Command): void {
  const opencode = program.command("opencode").description("OpenCode-specific utilities");

  opencode
    .command("install-plugin")
    .description(
      "Install the open-agent-bridge plugin into an OpenCode project (or globally). " +
        "It registers the MCP server and turns each channel message into a new turn in the " +
        "session in use; on OpenCode 2 its terminal half also opens that session from the home screen.",
    )
    .option("--project <path>", "Project path (default: cwd)", process.cwd())
    .option("--global", "Install to ~/.config/opencode/plugins/ instead of the project directory")
    .action((options: { project: string; global?: boolean }) => {
      const projectPath = resolve(options.project);
      const isGlobal = Boolean(options.global);

      let pluginDir: string;
      let configPath: string;

      if (isGlobal) {
        pluginDir = join(homedir(), ".config", "opencode", "plugins");
        configPath = join(homedir(), ".config", "opencode", "opencode.json");
      } else {
        pluginDir = join(projectPath, ".opencode", "plugins");
        configPath = join(projectPath, ".opencode", "opencode.json");
      }

      const scope = isGlobal ? "global (~/.config/opencode/)" : `project (${projectPath})`;
      console.log(chalk.bold(`\n[open-agent-bridge] opencode install-plugin\n`));
      console.log(`  Scope:      ${scope}`);
      console.log(`  Plugin dir: ${pluginDir}`);
      console.log(`  Config:     ${configPath}`);
      console.log();

      // 1. Ensure the plugin directory exists
      mkdirSync(pluginDir, { recursive: true });

      // 2. Copy agent-bridge.ts
      let sourceDir: string;
      try {
        sourceDir = resolvePluginSourceDir();
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`));
        process.exit(1);
      }

      if (openCodeMajor() < 2) {
        // OpenCode 1 loads single files, and has no terminal plugins.
        copyFileSync(join(sourceDir, "agent-bridge.ts"), join(pluginDir, "agent-bridge.ts"));
        console.log(chalk.green("✓") + ` Copied plugin to ${join(pluginDir, "agent-bridge.ts")}`);
      } else {
        // OpenCode 2 loads `<plugins>/<name>/index.ts` (server) and `tui.ts` (terminal) together.
        const destDir = join(pluginDir, "open-agent-bridge");
        mkdirSync(destDir, { recursive: true });
        copyFileSync(join(sourceDir, "agent-bridge.ts"), join(destDir, "index.ts"));
        copyFileSync(join(sourceDir, "tui.ts"), join(destDir, "tui.ts"));
        // The single-file layout would load a second copy.
        rmSync(join(pluginDir, "agent-bridge.ts"), { force: true });
        console.log(chalk.green("✓") + ` Copied plugin to ${destDir}/ (index.ts + tui.ts)`);
      }

      // 3. Copy package.json (for bun install to resolve ws dependency)
      const srcPkg = join(sourceDir, "package.json");
      const destPkg = isGlobal
        ? join(homedir(), ".config", "opencode", "package.json")
        : join(projectPath, ".opencode", "package.json");

      if (existsSync(srcPkg)) {
        let mergedPkg: Record<string, unknown> = {};
        if (existsSync(destPkg)) {
          try {
            mergedPkg = JSON.parse(readFileSync(destPkg, "utf-8")) as Record<string, unknown>;
          } catch {
            // overwrite malformed
          }
        }
        const pluginPkg = JSON.parse(readFileSync(srcPkg, "utf-8")) as Record<string, unknown>;
        const existing = (mergedPkg["dependencies"] as Record<string, string> | undefined) ?? {};
        const incoming = (pluginPkg["dependencies"] as Record<string, string> | undefined) ?? {};
        mergedPkg["dependencies"] = { ...existing, ...incoming };
        writeFileSync(destPkg, JSON.stringify(mergedPkg, null, 2) + "\n", "utf-8");
        console.log(chalk.green("✓") + ` Merged dependencies into ${destPkg}`);
      }

      // Note: local plugins in .opencode/plugins/ are auto-scanned by OpenCode.
      // No opencode.json entry is needed.

      console.log();
      console.log(chalk.bold("Done!") + " Restart OpenCode for the plugin to load.");
      console.log(
        chalk.dim(
          "  Once loaded, OpenCode shows up as [OpenCode] in list_agents and channel messages\n" +
            "  arrive as a new turn in the session in use (no inbox polling).",
        ),
      );
      console.log();
    });
}
