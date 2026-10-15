import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildMcpServerEntry,
  buildCodexMcpAddArgs,
  writeCodexProjectConfig,
  writeMcpConfig,
  MCP_SERVER_NAME,
} from "../cli/lib/mcp-config.js";

describe("buildMcpServerEntry", () => {
  it("injects AGENT_BRIDGE_IDENTITY for a non-global identity", () => {
    const entry = buildMcpServerEntry({ projectPath: "/proj", identity: "dev", mode: "local" });
    expect(entry.env.AGENT_BRIDGE_PROJECT).toBe("/proj");
    expect(entry.env.AGENT_BRIDGE_IDENTITY).toBe("dev");
  });

  it("omits AGENT_BRIDGE_IDENTITY for the default global namespace", () => {
    const entry = buildMcpServerEntry({ projectPath: "/proj", identity: "global", mode: "local" });
    expect(entry.env.AGENT_BRIDGE_IDENTITY).toBeUndefined();
  });

  it("omits AGENT_BRIDGE_IDENTITY when no identity is given", () => {
    const entry = buildMcpServerEntry({ projectPath: "/proj", mode: "local" });
    expect(entry.env.AGENT_BRIDGE_IDENTITY).toBeUndefined();
  });

  it("uses node + dist entry in local mode", () => {
    const entry = buildMcpServerEntry({ projectPath: "/proj", mode: "local" });
    expect(entry.command).toBe("node");
    expect(entry.args[0]).toMatch(/index\.js$/);
    expect(entry.args.slice(1)).toEqual(["mcp", "start"]);
  });

  it("invokes the binary by name in linked mode", () => {
    const entry = buildMcpServerEntry({ projectPath: "/proj", mode: "linked" });
    expect(["open-agent-bridge", "oab"]).toContain(entry.command);
    expect(entry.args).toEqual(["mcp", "start"]);
  });
});

describe("writeCodexProjectConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "codex-cfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const entry = {
    command: "open-agent-bridge",
    args: ["mcp", "start"],
    env: { AGENT_BRIDGE_PROJECT: "/my proj", AGENT_BRIDGE_IDENTITY: "ril" },
  };

  it("declares the server with its env so the inner Codex client shares the identity", () => {
    const { path, written } = writeCodexProjectConfig(dir, entry);

    expect(written).toBe(true);
    const toml = readFileSync(path, "utf-8");
    expect(path.endsWith(join(".codex", "config.toml"))).toBe(true);
    expect(toml).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(toml).toContain('command = "open-agent-bridge"');
    expect(toml).toContain('args = ["mcp", "start"]');
    expect(toml).toContain('AGENT_BRIDGE_IDENTITY = "ril"');
    // Paths with spaces must survive as quoted TOML strings.
    expect(toml).toContain('AGENT_BRIDGE_PROJECT = "/my proj"');
  });

  it("leaves an existing declaration alone instead of clobbering it", () => {
    writeCodexProjectConfig(dir, entry);
    const first = readFileSync(join(dir, ".codex", "config.toml"), "utf-8");

    const second = writeCodexProjectConfig(dir, { ...entry, env: { AGENT_BRIDGE_IDENTITY: "other" } });

    expect(second.written).toBe(false);
    expect(readFileSync(second.path, "utf-8")).toBe(first);
  });

  it("appends to an existing config without dropping other sections", () => {
    const cfg = join(dir, ".codex", "config.toml");
    writeFileSync(join(dir, ".codex-placeholder"), "");
    mkdirSync(join(dir, ".codex"), { recursive: true });
    writeFileSync(cfg, 'model = "gpt-5.4-mini"\n');

    writeCodexProjectConfig(dir, entry);

    const toml = readFileSync(cfg, "utf-8");
    expect(toml).toContain('model = "gpt-5.4-mini"');
    expect(toml).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
  });
});

describe("buildCodexMcpAddArgs", () => {
  it("never pins project or identity in Codex's global config", () => {
    // ~/.codex/config.toml applies to every Codex session on the machine.
    const args = buildCodexMcpAddArgs({
      command: "open-agent-bridge",
      args: ["mcp", "start"],
      env: { AGENT_BRIDGE_PROJECT: "/my proj", AGENT_BRIDGE_IDENTITY: "ril" },
    });
    expect(args).toEqual(["mcp", "add", MCP_SERVER_NAME, "--", "open-agent-bridge", "mcp", "start"]);
  });
});

describe("writeMcpConfig", () => {
  let dir: string;
  let target: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oab-mcp-"));
    target = join(dir, ".mcp.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a fresh file when none exists", () => {
    const entry = buildMcpServerEntry({ projectPath: dir, identity: "x", mode: "local" });
    const { merged } = writeMcpConfig(target, entry);
    expect(merged).toBe(false);
    const cfg = JSON.parse(readFileSync(target, "utf-8"));
    expect(cfg.mcpServers[MCP_SERVER_NAME].env.AGENT_BRIDGE_IDENTITY).toBe("x");
  });

  it("preserves other MCP servers (non-destructive merge)", () => {
    writeFileSync(
      target,
      JSON.stringify({ mcpServers: { other: { command: "foo", args: [], env: {} } } }),
      "utf-8",
    );
    const entry = buildMcpServerEntry({ projectPath: dir, mode: "local" });
    const { merged } = writeMcpConfig(target, entry);
    expect(merged).toBe(true);
    const cfg = JSON.parse(readFileSync(target, "utf-8"));
    expect(cfg.mcpServers.other).toBeDefined();
    expect(cfg.mcpServers.other.command).toBe("foo");
    expect(cfg.mcpServers[MCP_SERVER_NAME]).toBeDefined();
  });

  it("overwrites a malformed file instead of throwing", () => {
    writeFileSync(target, "{ not json", "utf-8");
    const entry = buildMcpServerEntry({ projectPath: dir, mode: "local" });
    expect(() => writeMcpConfig(target, entry)).not.toThrow();
    const cfg = JSON.parse(readFileSync(target, "utf-8"));
    expect(cfg.mcpServers[MCP_SERVER_NAME]).toBeDefined();
  });

  it("preserves top-level keys other than mcpServers", () => {
    writeFileSync(target, JSON.stringify({ $schema: "x", mcpServers: {} }), "utf-8");
    const entry = buildMcpServerEntry({ projectPath: dir, mode: "local" });
    writeMcpConfig(target, entry);
    const cfg = JSON.parse(readFileSync(target, "utf-8"));
    expect(cfg.$schema).toBe("x");
  });
});
