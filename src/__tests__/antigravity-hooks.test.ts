import { describe, expect, it } from "vitest";
import {
  buildSessionStartHookOutput,
  buildStopHookOutput,
} from "../client/antigravity-hooks.js";

/**
 * The Stop hook is Antigravity's native auto-arrival trigger: when the agent
 * tries to stop, returning {"decision":"continue","reason":...} forces it to keep
 * going with the reason text as input. We use it to deliver pending channel
 * messages so the agent answers them without a human re-prompt.
 */

describe("buildStopHookOutput", () => {
  it("keeps the agent going and names pending senders when messages are pending", () => {
    const out = buildStopHookOutput([
      { fromAgentName: "claude", content: "review the PR", conversationId: "c1" },
      { fromAgentName: "codex", content: "ping", conversationId: "c2" },
    ]);

    expect(out.decision).toBe("continue");
    expect(out.reason).toContain("channel_inbox");
    expect(out.reason).toContain("2");
  });

  it("returns an empty object (allows stop) when nothing is pending", () => {
    expect(buildStopHookOutput([])).toEqual({});
  });
});

describe("buildSessionStartHookOutput", () => {
  it("injects a system message describing the bridge when pending exist", () => {
    const out = buildSessionStartHookOutput(1);
    expect(out.injectSteps).toHaveLength(1);
    expect(out.injectSteps?.[0].systemMessage.systemMessage).toContain("channel_inbox");
  });

  it("returns an empty object when no pending messages", () => {
    expect(buildSessionStartHookOutput(0)).toEqual({});
  });
});

describe("buildSessionStartHookOutput before attach", () => {
  it("asks the agent to attach so live delivery can start", () => {
    const out = buildSessionStartHookOutput(0, { attached: false });
    expect(out.injectSteps?.[0].systemMessage.systemMessage).toContain("open-agent-bridge antigravity attach");
  });
});
