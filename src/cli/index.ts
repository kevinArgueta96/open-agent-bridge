#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { registerInitCommand } from "./commands/init.js";
import { registerUpCommand } from "./commands/up.js";
import { registerStartCommand } from "./commands/start.js";
import { registerRegistryCommand } from "./commands/registry.js";
import { registerListCommand } from "./commands/list.js";
import { registerPruneCommand } from "./commands/prune.js";
import { registerHealthCommand } from "./commands/health.js";
import { registerAskCommand } from "./commands/ask.js";
import { registerFindCommand } from "./commands/find.js";
import { registerDelegateCommand } from "./commands/delegate.js";
import { registerBroadcastCommand } from "./commands/broadcast.js";
import { registerMcpCommand } from "./commands/mcp.js";
import { registerLaunchCommand } from "./commands/launch.js";
import { registerDoctorCommand } from "./commands/doctor.js";
import { registerDashboardCommand } from "./commands/dashboard.js";
import { registerCodexCommand } from "./commands/codex.js";
import { registerAntigravityCommand } from "./commands/antigravity.js";
import { registerOpenCodeCommand } from "./commands/opencode.js";
import { registerPiCommand } from "./commands/pi.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readVersion(): string {
  try {
    // dist/cli/index.js → ../../package.json (package root)
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const program = new Command();

program
  .name("open-agent-bridge")
  .description("Local agent communication protocol — A2A + MCP + WebSocket")
  .version(readVersion());

// Setup & lifecycle (the low-friction surface)
registerInitCommand(program);
registerUpCommand(program);
registerLaunchCommand(program);
registerDoctorCommand(program);

// Core
registerStartCommand(program);
registerRegistryCommand(program);
registerListCommand(program);
registerPruneCommand(program);
registerHealthCommand(program);
registerAskCommand(program);
registerFindCommand(program);
registerDelegateCommand(program);
registerBroadcastCommand(program);
registerMcpCommand(program);
registerDashboardCommand(program);
registerCodexCommand(program);
registerAntigravityCommand(program);
registerOpenCodeCommand(program);
registerPiCommand(program);

program.parse(process.argv);
