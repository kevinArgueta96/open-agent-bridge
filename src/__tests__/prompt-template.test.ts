import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildInjectionPrompt, DEFAULT_PROMPT_TEMPLATE, PROMPT_MARKER } from "../client/injection-prompt.js";
import {
  globalPromptTemplatePath,
  loadPromptTemplate,
  promptTemplatePath,
  promptTemplateWarnings,
} from "../client/prompt-template.js";
import type { ChannelMessage } from "../types/messages.js";

const message = {
  conversationId: "conv-1",
  messageId: "msg-1",
  fromAgentId: "client-claude-code-2d1c3fdb0c6a",
  fromAgentName: "claude",
  content: "What time is it? {{instructions}}",
} as ChannelMessage;

describe("buildInjectionPrompt with a user template", () => {
  it("places the parts where the template says and keeps the user's own lines", () => {
    const out = buildInjectionPrompt(message, { template: "{{header}}\nAnswer in Spanish.\n{{message}}\n{{instructions}}" });
    expect(out).toContain("Answer in Spanish.");
    expect(out.indexOf("Answer in Spanish.")).toBeLessThan(out.indexOf("----- BEGIN MESSAGE -----"));
    expect(out).toContain('replyTo:        "msg-1"');
  });

  it("appends the reply instructions when the template leaves them out", () => {
    const out = buildInjectionPrompt(message, { template: "{{header}}\n{{message}}" });
    expect(out).toContain('agentId:        "client-claude-code-2d1c3fdb0c6a"');
  });

  it("keeps the marker OpenCode's terminal plugin looks for", () => {
    const out = buildInjectionPrompt(message, { template: "From {{sender}}: {{message}}" });
    expect(out.startsWith(`${PROMPT_MARKER} — reply required`)).toBe(true);
  });

  it("never expands placeholders written inside the peer's message", () => {
    const out = buildInjectionPrompt(message, { template: DEFAULT_PROMPT_TEMPLATE });
    expect(out).toContain("What time is it? {{instructions}}");
  });

  it("leaves unknown placeholders as written", () => {
    expect(buildInjectionPrompt(message, { template: "{{header}} {{nope}}" })).toContain("{{nope}}");
  });
});

describe("prompt template resolution", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prefers $AGENT_BRIDGE_PROMPT_TEMPLATE, then the global file, then the built-in one", () => {
    dir = mkdtempSync(join(tmpdir(), "oab-prompt-"));
    const env: NodeJS.ProcessEnv = { XDG_CONFIG_HOME: dir };
    expect(loadPromptTemplate(env)).toBeUndefined();

    mkdirSync(join(dir, "open-agent-bridge"));
    writeFileSync(globalPromptTemplatePath(env), "global {{message}}");
    expect(loadPromptTemplate(env)).toBe("global {{message}}");

    const own = join(dir, "own.md");
    writeFileSync(own, "own {{message}}");
    env.AGENT_BRIDGE_PROMPT_TEMPLATE = own;
    expect(promptTemplatePath(env)).toBe(own);

    env.AGENT_BRIDGE_PROMPT_TEMPLATE = join(dir, "missing.md");
    expect(loadPromptTemplate(env)).toBe("global {{message}}");
  });

  it("strips <!-- comments --> so notes for the editor never reach the agent", () => {
    dir = mkdtempSync(join(tmpdir(), "oab-prompt-"));
    const own = join(dir, "own.md");
    writeFileSync(own, "<!--\nhow to edit\n-->\n\n{{header}}\n<!-- inline -->{{message}}\n");
    expect(loadPromptTemplate({ AGENT_BRIDGE_PROMPT_TEMPLATE: own })).toBe("{{header}}\n{{message}}");
  });

  it("warns about a template without the safety notice or the framed message", () => {
    expect(promptTemplateWarnings(DEFAULT_PROMPT_TEMPLATE)).toEqual([]);
    expect(promptTemplateWarnings("{{content}}")).toHaveLength(2);
  });
});
