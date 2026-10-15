import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Client for the Antigravity (`agy`) Cascade Language Server.
 *
 * `agy` runs an internal Language Server that listens on two random localhost
 * ports — one HTTP (connect/JSON), one HTTPS (gRPC). Driving the HTTP one with
 * connect/JSON (no auth on localhost) lets us inject a real user turn into the
 * live TUI via `SendUserCascadeMessage` — the only mechanism that makes an idle
 * `agy` process a message without the user typing.
 *
 * This is an UNDOCUMENTED internal RPC surface (Codeium/Windsurf lineage). All
 * coupling to it is intentionally isolated in this file to bound the blast
 * radius if a future `agy` version changes it.
 */

const LS_SERVICE = "exa.language_server_pb.LanguageServerService";
const LOG_DIR = join(homedir(), ".gemini", "antigravity-cli", "log");

/** Extract the most-recent HTTP (connect) port from `agy` CLI log text. The log
 *  prints both the HTTPS/gRPC and HTTP ports; we want the HTTP one. */
export function parseLatestHttpPort(logText: string): number | undefined {
  let port: number | undefined;
  const re = /listening on random port at (\d+) for HTTP(?!S)/g;
  for (const m of logText.matchAll(re)) {
    port = Number(m[1]);
  }
  return port;
}

interface TrajectorySummary {
  lastModifiedTime?: string;
  status?: string;
  trajectoryId?: string;
  workspaces?: Array<{ workspaceFolderAbsoluteUri?: string }>;
}
interface CascadeTrajectoriesResponse {
  trajectorySummaries?: Record<string, TrajectorySummary>;
}

/** Pick the most-recently-modified cascadeId whose workspace matches the given
 *  project path. Returns undefined when none match. */
export function pickActiveCascadeId(
  resp: CascadeTrajectoriesResponse,
  projectPath: string,
): string | undefined {
  const summaries = resp.trajectorySummaries ?? {};
  const matches = Object.entries(summaries).filter(([, t]) =>
    (t.workspaces ?? []).some((w) => decodeWorkspaceUri(w.workspaceFolderAbsoluteUri) === projectPath),
  );
  if (matches.length === 0) return undefined;
  matches.sort((a, b) => (b[1].lastModifiedTime ?? "").localeCompare(a[1].lastModifiedTime ?? ""));
  return matches[0][0];
}

function decodeWorkspaceUri(uri?: string): string {
  if (!uri) return "";
  try {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  } catch {
    return uri.replace(/^file:\/\//, "");
  }
}

/** Where agy's language server listens. agy ≥ 1.3 rejects RPCs without the
 *  CSRF token it hands to its sidecars (`x-codeium-csrf-token`). */
export interface LsTarget {
  url: string;
  csrf?: string;
}

/** The language server of the agy process that started us as a sidecar. */
export function lsTargetFromEnv(env: NodeJS.ProcessEnv = process.env): LsTarget | undefined {
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  if (!address) return undefined;
  return { url: address.startsWith("http") ? address : `http://${address}`, csrf: env.ANTIGRAVITY_CSRF_TOKEN };
}

async function rpc(target: number | LsTarget, method: string, body: unknown): Promise<unknown> {
  const { url, csrf } = typeof target === "number" ? { url: `http://127.0.0.1:${target}`, csrf: undefined } : target;
  const res = await fetch(`${url}/${LS_SERVICE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(csrf ? { "x-codeium-csrf-token": csrf } : {}) },
    body: JSON.stringify(body ?? {}),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/** Verify a port is the LS HTTP endpoint by calling the no-op GetWorkspaceInfos. */
async function isLsHttpPort(port: number): Promise<boolean> {
  try {
    await rpc(port, "GetWorkspaceInfos", {});
    return true;
  } catch {
    return false;
  }
}

/** Find the LS HTTP port: prefer the CLI log, fall back to scanning the agy
 *  process's listening ports. Verifies the candidate actually speaks connect. */
export async function discoverLsHttpPort(): Promise<number | undefined> {
  // 1. From the most-recent CLI log.
  try {
    if (existsSync(LOG_DIR)) {
      const logs = (await readdir(LOG_DIR))
        .filter((f) => f.endsWith(".log"))
        .map((f) => join(LOG_DIR, f));
      // Read each log newest-first by filename (timestamped); first port that
      // actually answers connect wins.
      for (const p of logs.sort().reverse()) {
        const port = parseLatestHttpPort(readFileSync(p, "utf8"));
        if (port && (await isLsHttpPort(port))) return port;
      }
    }
  } catch {
    // fall through to socket scan
  }

  // 2. Fall back to the agy process's listening localhost ports.
  try {
    const { stdout } = await execFileAsync("ss", ["-tlnp"]);
    const ports = new Set<number>();
    for (const line of stdout.split("\n")) {
      if (!line.includes('"agy"')) continue;
      const m = line.match(/127\.0\.0\.1:(\d+)/);
      if (m) ports.add(Number(m[1]));
    }
    for (const port of ports) {
      if (await isLsHttpPort(port)) return port;
    }
  } catch {
    // ss unavailable
  }
  return undefined;
}

/** Resolve the active cascadeId for a project workspace, or undefined. */
export async function getActiveCascadeId(
  target: number | LsTarget,
  projectPath: string,
): Promise<string | undefined> {
  const resp = (await rpc(target, "GetAllCascadeTrajectories", {})) as CascadeTrajectoriesResponse;
  return pickActiveCascadeId(resp, projectPath);
}

/** Inject a USER message into the live cascade — this triggers a real turn, so
 *  `agy` processes it without the user typing. `messageOrigin` tags the source
 *  (a known enum) so agy treats it as an external/SDK-driven message. Returns
 *  true on HTTP 200. */
export async function sendUserCascadeMessage(
  target: number | LsTarget,
  cascadeId: string,
  text: string,
): Promise<boolean> {
  await rpc(target, "SendUserCascadeMessage", {
    cascadeId,
    items: [{ text }],
    // Enum names from agy 1.3.4 (`exa.cortex_pb`); the old MESSAGE_ORIGIN_* value does not exist.
    messageOrigin: "AGENT_MESSAGE_ORIGIN_SDK_EXECUTABLE",
    // Queue behind a running turn instead of being rejected or interrupting it.
    deliveryStrategy: "MESSAGE_DELIVERY_STRATEGY_WHEN_IDLE",
  });
  return true;
}
