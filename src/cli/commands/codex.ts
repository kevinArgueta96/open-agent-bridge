import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { type Command, Option } from "commander";
import chalk from "chalk";
import { CodexTmuxBridgeService } from "../../client/codex-tmux-bridge-service.js";
import { detectCurrentTmuxBinding } from "../../client/codex-tmux.js";
import { readCurrentCodexSession, writeCurrentCodexSession } from "../../client/codex-session-files.js";
import { CodexAppServerBridge } from "../../client/codex-app-server-bridge.js";
import { RegistryServer } from "../../registry/server.js";
import { RegistryClient } from "../../client/registry-client.js";
import { buildMcpServerEntry, writeCodexProjectConfig } from "../lib/mcp-config.js";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => { server.close(); resolve(true); });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort: number, maxAttempts = 20): Promise<number> {
  for (let port = startPort; port < startPort + maxAttempts; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error(`No available port found in range ${startPort}–${startPort + maxAttempts - 1}`);
}

// Reasoning efforts codex-cli 0.146 knows; the model must also advertise the
// one picked, or turn/start is rejected (and the message is acked `failed`).
const effortOption = () =>
  new Option("--effort <level>", "Reasoning effort for channel turns; `ultra` = proactive sub-agent delegation")
    .choices(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function registerCodexCommand(program: Command): void {
  const codex = program.command("codex").description("Codex-specific utilities");

  // ── codex start — one-command startup ─────────────────────────────────────
  codex
    .command("start")
    .description(
      "Start Codex with full bidirectional channel bridge in one command. " +
      "Auto-starts the registry if not running, spawns the app-server bridge " +
      "(bridge connects directly as a second WS client), then launches the " +
      "Codex TUI connected directly to the app-server."
    )
    .option("--project <path>", "Project path", process.cwd())
    .option("--app-server-port <number>", "Starting port for the codex app-server (auto-increments if busy)", "4500")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--identity <id>", "Channel namespace — only sessions sharing it see each other (default: global)")
    .addOption(effortOption())
    .action(async (options) => {
      const projectPath = options.project ?? process.cwd();
      const registryUrl: string = options.registryUrl;
      const requestedPort = Number(options.appServerPort);
      const appServerPort = await findAvailablePort(requestedPort);
      if (appServerPort !== requestedPort) {
        console.log(chalk.yellow(`  Port ${requestedPort} busy → using ${appServerPort}`));
      }
      const appServerWsUrl = `ws://127.0.0.1:${appServerPort}`;

      console.log(chalk.bold("\n[open-agent-bridge] codex start\n"));
      console.log(`  Project:    ${projectPath}`);
      console.log(`  Registry:   ${registryUrl}`);
      console.log(`  App-server: ${appServerWsUrl}`);
      console.log();

      // 1. Ensure registry is running — embed one if not reachable
      let embeddedRegistry: RegistryServer | null = null;
      const registryClient = new RegistryClient(registryUrl);
      try {
        await registryClient.health();
        console.log(chalk.green("✓") + " Registry already running at " + registryUrl);
      } catch {
        console.log(chalk.yellow("→") + " Registry not found — starting embedded registry…");
        const registryPort = Number(new URL(registryUrl).port) || 4999;
        embeddedRegistry = new RegistryServer(registryPort);
        await embeddedRegistry.start();
        console.log(chalk.green("✓") + " Embedded registry started on :" + registryPort);
      }

      // 1b. Give the MCP client inside Codex the same identity as the bridge.
      //     A Codex session registers two entries; `--identity` alone only
      //     reached the bridge, leaving the inner client in `global` and the
      //     pair split across the identity wall.
      if (options.identity && options.identity !== "global") {
        const entry = buildMcpServerEntry({ projectPath, identity: options.identity });
        const { path, written } = writeCodexProjectConfig(projectPath, entry);
        console.log(
          written
            ? chalk.green("✓") + ` Identity ${options.identity} declared for Codex in ${path}`
            : chalk.dim(`  Codex MCP already declared in ${path} — leaving it as is`),
        );
      }

      // 2. Start the bridge (spawns app-server, bridge connects directly as second WS client)
      const bridge = new CodexAppServerBridge({
        registryUrl,
        projectPath,
        appServerPort,
        identity: options.identity,
        effort: options.effort,
      });

      try {
        await bridge.start();
      } catch (err) {
        console.error(chalk.red("Failed to start bridge:"), err instanceof Error ? err.message : err);
        if (embeddedRegistry) await embeddedRegistry.stop();
        process.exit(1);
      }

      console.log(chalk.green("✓") + " Bridge ready. Launching Codex TUI…\n");

      // 3. Redirect bridge/registry stderr to a log file so it doesn't pollute the TUI
      const logFile = join(tmpdir(), `open-agent-bridge-codex-${process.pid}.log`);
      const logStream = createWriteStream(logFile, { flags: "a" });
      const originalStderrWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
        return logStream.write(chunk, args[0] as BufferEncoding);
      }) as typeof process.stderr.write;
      console.log(chalk.dim(`  Logs: ${logFile}\n`));

      // 4. Spawn codex TUI directly to the app-server (no proxy).
      //    Identity rides in the environment exactly as `oab claude` does: a
      //    Codex session registers TWO entries — this bridge and the MCP client
      //    running inside Codex — and `--identity` only reached the bridge.
      //    Leaving the inner client in `global` split the pair across two
      //    namespaces, and identity is a hard wall, so the pairing that lets a
      //    message addressed to the inner client reach the bridge broke.
      const tuiEnv: NodeJS.ProcessEnv = { ...process.env, AGENT_BRIDGE_PROJECT: projectPath };
      if (options.identity) tuiEnv.AGENT_BRIDGE_IDENTITY = options.identity;

      const tui = spawn("codex", ["--remote", appServerWsUrl], {
        stdio: "inherit",
        cwd: projectPath,
        env: tuiEnv,
      });

      const cleanup = async () => {
        process.stderr.write = originalStderrWrite;
        tui.kill("SIGTERM");
        await bridge.stop();
        if (embeddedRegistry) await embeddedRegistry.stop();
        logStream.end();
      };

      tui.on("exit", (code) => {
        process.stderr.write = originalStderrWrite;
        void bridge.stop()
          .then(() => embeddedRegistry?.stop())
          .then(() => { logStream.end(); process.exit(code ?? 0); });
      });

      process.on("SIGINT", () => void cleanup().then(() => process.exit(0)));
      process.on("SIGTERM", () => void cleanup().then(() => process.exit(0)));
      process.on("SIGHUP", () => void cleanup().then(() => process.exit(0)));
    });

  // ── codex app-bridge ───────────────────────────────────────────────────────
  codex
    .command("app-bridge")
    .description(
      "Start a Codex app-server bridge daemon. Spawns codex app-server and connects " +
      "the bridge as a direct WS client. Channel messages are injected via turn/start. " +
      "After starting, launch Codex with: codex --remote ws://127.0.0.1:<app-server-port>"
    )
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--project <path>", "Project path for client registration (default: cwd)")
    .option("--app-server-port <number>", "Starting port for the codex app-server (auto-increments if busy)", "4500")
    .option("--identity <id>", "Channel namespace — only sessions sharing it see each other (default: global)")
    .addOption(effortOption())
    .action(async (options) => {
      const projectPath = options.project ?? process.cwd();
      const requestedPort = Number(options.appServerPort);
      const appServerPort = await findAvailablePort(requestedPort);
      if (appServerPort !== requestedPort) {
        console.log(chalk.yellow(`  Port ${requestedPort} busy → using ${appServerPort}`));
      }

      const bridge = new CodexAppServerBridge({
        registryUrl: options.registryUrl,
        projectPath,
        appServerPort,
        identity: options.identity,
        effort: options.effort,
      });

      console.log(chalk.bold("\n[open-agent-bridge] Codex app-server bridge\n"));
      console.log(`  Project:    ${projectPath}`);
      console.log(`  Registry:   ${options.registryUrl}`);
      console.log(`  App-server: ws://127.0.0.1:${appServerPort}`);
      console.log();

      try {
        await bridge.start();
      } catch (err) {
        console.error(chalk.red("Failed to start bridge:"), err instanceof Error ? err.message : err);
        process.exit(1);
      }

      console.log(chalk.green("✓") + " Bridge running. Start Codex with:");
      console.log(chalk.cyan(`  codex --remote ws://127.0.0.1:${appServerPort}\n`));

      const shutdown = async () => {
        console.log("\n[open-agent-bridge] Shutting down...");
        await bridge.stop();
        process.exit(0);
      };

      process.on("SIGINT", () => void shutdown());
      process.on("SIGTERM", () => void shutdown());
      process.on("SIGHUP", () => void shutdown());

      // Keep process alive
      await new Promise<never>(() => undefined);
    });

  codex
    .command("tmux-bind")
    .description("Bind the current Codex client session to a tmux pane so open-agent-bridge can inject follow-up prompts")
    .option("--project <path>", "Project path override", process.cwd())
    .option("--client-id <id>", "Exact Codex client session ID to bind")
    .option("--pane <pane>", "Explicit tmux pane target, for example %12")
    .action(async (options) => {
      const binding = await detectCurrentTmuxBinding(options.pane);
      if (!binding?.pane) {
        console.error(chalk.red("No tmux pane detected. Run this inside tmux or pass --pane explicitly."));
        process.exit(1);
      }

      const current = readCurrentCodexSession(options.project);
      const clientAgentId = options.clientId ?? current?.clientAgentId;
      if (!clientAgentId) {
        console.error(chalk.red("No Codex client session marker found. Start Codex first or pass --client-id."));
        process.exit(1);
      }

      writeCurrentCodexSession(options.project, {
        clientAgentId,
        clientName: current?.clientName ?? "codex",
        projectPath: options.project,
        registeredAt: current?.registeredAt ?? Date.now(),
        sidecarPid: current?.sidecarPid,
        tmuxPane: binding.pane,
        tmuxSessionName: binding.sessionName,
        tmuxWindowName: binding.windowName,
        tmuxCurrentCommand: binding.currentCommand,
      });

      console.log(chalk.green("✓") + " Codex tmux binding updated");
      console.log(`  Client: ${clientAgentId}`);
      console.log(`  Pane: ${binding.pane}`);
      if (binding.sessionName) console.log(`  Session: ${binding.sessionName}`);
      if (binding.windowName) console.log(`  Window: ${binding.windowName}`);
      if (binding.currentCommand) console.log(`  Command: ${binding.currentCommand}`);
    });

  codex
    .command("tmux-sidecar")
    .description("Run a per-session tmux sidecar that injects pending channel follow-ups into the active Codex pane")
    .option("--registry-url <url>", "Registry URL", "http://localhost:4999")
    .option("--project <path>", "Project path override", process.cwd())
    .option("--client-id <id>", "Exact Codex client session ID to control")
    .option("--tmux-pane <pane>", "Explicit tmux pane target, for example %12")
    .option("--poll-interval-ms <number>", "Polling interval in milliseconds", "2000")
    .option("--retry-interval-ms <number>", "Retry interval for the same pending message", "30000")
    .option("--verbose", "Enable verbose sidecar logs")
    .option("--once", "Run one poll cycle and exit")
    .action(async (options) => {
      const service = new CodexTmuxBridgeService({
        projectPath: options.project,
        registryUrl: options.registryUrl,
        clientId: options.clientId,
        tmuxPane: options.tmuxPane,
        pollIntervalMs: Number(options.pollIntervalMs),
        retryIntervalMs: Number(options.retryIntervalMs),
        verbose: options.verbose === true,
      });

      if (options.once) {
        const pending = await service.runOnce();
        console.log(chalk.cyan(`[Codex Tmux Sidecar] scanned ${pending.length} pending conversation(s)`));
        return;
      }

      console.log(chalk.green("✓") + " Codex tmux sidecar running");
      console.log(`  Project: ${options.project}`);
      console.log(`  Client: ${options.clientId ?? "(auto)"}`);
      console.log(`  Pane: ${options.tmuxPane ?? "(marker/auto)"}`);
      console.log(`  Registry: ${options.registryUrl}`);
      console.log(`  Poll: ${options.pollIntervalMs}ms`);
      console.log(`  Retry: ${options.retryIntervalMs}ms`);

      await service.start();

      process.on("SIGINT", () => { service.stop(); process.exit(0); });
      process.on("SIGTERM", () => { service.stop(); process.exit(0); });
      process.on("SIGHUP", () => { service.stop(); process.exit(0); });
    });
}
