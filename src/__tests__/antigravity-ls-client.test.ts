import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agyConversationPath,
  parseLatestHttpPort,
  pickActiveCascadeId,
  readAgyConversation,
  writeAgyConversation,
} from "../client/antigravity-ls-client.js";

describe("agy conversation handoff (hook → adapter)", () => {
  it("round-trips privately, and is ignored without a token", () => {
    const env = { XDG_RUNTIME_DIR: mkdtempSync(join(tmpdir(), "oab-rt-")) };
    try {
      expect(readAgyConversation(77, env)).toBeUndefined();
      writeAgyConversation(77, { url: "http://127.0.0.1:1", csrf: "t", cascadeId: "c1" }, env);
      expect(readAgyConversation(77, env)?.cascadeId).toBe("c1");
      expect(statSync(agyConversationPath(77, env)).mode & 0o777).toBe(0o600);
      writeAgyConversation(78, { url: "http://127.0.0.1:1", cascadeId: "c2" }, env);
      expect(readAgyConversation(78, env)).toBeUndefined();
    } finally {
      rmSync(env.XDG_RUNTIME_DIR, { recursive: true, force: true });
    }
  });
});

/**
 * The Antigravity (`agy`) Cascade Language Server listens on two random
 * localhost ports — one HTTP (connect/JSON), one HTTPS (gRPC). The CLI log
 * announces both; we drive the HTTP one. SendUserCascadeMessage needs the
 * active cascadeId of the workspace's most-recent trajectory.
 */

describe("parseLatestHttpPort", () => {
  it("extracts the HTTP port (not the gRPC one) from the log", () => {
    const log = [
      "I0602 server.go:489] Language server listening on random port at 38793 for HTTPS (gRPC)",
      "I0602 server.go:496] Language server listening on random port at 43473 for HTTP",
    ].join("\n");
    expect(parseLatestHttpPort(log)).toBe(43473);
  });

  it("returns the LAST HTTP port when the log has several (restarts)", () => {
    const log = [
      "listening on random port at 11111 for HTTP",
      "listening on random port at 22222 for HTTPS (gRPC)",
      "listening on random port at 33333 for HTTP",
    ].join("\n");
    expect(parseLatestHttpPort(log)).toBe(33333);
  });

  it("returns undefined when no HTTP port line is present", () => {
    expect(parseLatestHttpPort("nothing here\nlistening on random port at 9 for HTTPS (gRPC)")).toBeUndefined();
  });
});

describe("pickActiveCascadeId", () => {
  const ws = "file:///home/u/proj";
  const resp = {
    trajectorySummaries: {
      old: {
        lastModifiedTime: "2026-06-02T10:00:00Z",
        status: "CASCADE_RUN_STATUS_IDLE",
        workspaces: [{ workspaceFolderAbsoluteUri: ws }],
      },
      newest: {
        lastModifiedTime: "2026-06-02T12:00:00Z",
        status: "CASCADE_RUN_STATUS_IDLE",
        workspaces: [{ workspaceFolderAbsoluteUri: ws }],
      },
      otherWorkspace: {
        lastModifiedTime: "2026-06-02T23:00:00Z",
        status: "CASCADE_RUN_STATUS_IDLE",
        workspaces: [{ workspaceFolderAbsoluteUri: "file:///home/u/other" }],
      },
    },
  };

  it("returns the most-recent cascadeId for the matching workspace", () => {
    expect(pickActiveCascadeId(resp, "/home/u/proj")).toBe("newest");
  });

  it("ignores trajectories of other workspaces", () => {
    expect(pickActiveCascadeId(resp, "/home/u/proj")).not.toBe("otherWorkspace");
  });

  it("returns undefined when no trajectory matches the workspace", () => {
    expect(pickActiveCascadeId(resp, "/home/u/nope")).toBeUndefined();
  });

  it("returns undefined for an empty trajectory set", () => {
    expect(pickActiveCascadeId({ trajectorySummaries: {} }, "/home/u/proj")).toBeUndefined();
  });
});
