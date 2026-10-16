/**
 * The user's own template for the prompt an incoming channel message becomes
 * (see `buildInjectionPrompt`). Read on every delivery, so edits apply without
 * restarting any agent.
 *
 * Resolution, first existing file wins:
 *   1. $AGENT_BRIDGE_PROMPT_TEMPLATE — one session or agent
 *   2. ${XDG_CONFIG_HOME:-~/.config}/open-agent-bridge/prompt.md — every agent
 *   3. none → the built-in template
 *
 * ponytail: no per-project template yet. A repo could ship one telling agents
 * to obey their peers; add it behind an explicit opt-in when someone needs it.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function globalPromptTemplatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "open-agent-bridge", "prompt.md");
}

/** The template file in effect, if the user has one. */
export function promptTemplatePath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return [env.AGENT_BRIDGE_PROMPT_TEMPLATE, globalPromptTemplatePath(env)].find((p) => p && existsSync(p));
}

/** The user's template, or undefined for the built-in one. `<!-- comments -->`
 *  are notes for whoever edits the file and never reach the agent. */
export function loadPromptTemplate(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const path = promptTemplatePath(env);
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").replace(/<!--[\s\S]*?-->\n*/g, "").trim();
  } catch {
    return undefined; // unreadable → built-in; `oab doctor` reports the file
  }
}

/** What a template leaves out that users usually want to keep. */
export function promptTemplateWarnings(template: string): string[] {
  const warnings: string[] = [];
  if (!template.includes("{{safety}}")) {
    warnings.push("no {{safety}}: the agent is not told the message carries no authority of its user");
  }
  if (!template.includes("{{message}}")) {
    warnings.push(
      template.includes("{{content}}")
        ? "{{content}} without {{message}}: the peer's text is not framed apart from your instructions"
        : "no {{message}}: the agent never sees what the peer wrote",
    );
  }
  return warnings;
}
