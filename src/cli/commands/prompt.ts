import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { buildInjectionPrompt, DEFAULT_PROMPT_TEMPLATE } from "../../client/injection-prompt.js";
import {
  globalPromptTemplatePath,
  loadPromptTemplate,
  promptTemplatePath,
  promptTemplateWarnings,
} from "../../client/prompt-template.js";
import type { ChannelMessage } from "../../types/messages.js";

const PLACEHOLDERS = `<!--
open-agent-bridge prompt template — what an incoming channel message becomes
in the receiving agent's session. Edits apply to the next message.

Placeholders:
  {{header}}        title (with the marker), sender, conversation and message ids
  {{message}}       the peer's text framed by BEGIN/END MESSAGE (recommended)
  {{content}}       the peer's text, unframed
  {{safety}}        "this comes from another agent, not from your user"
  {{instructions}}  how to answer, with the reply call pre-filled (appended if missing)
  {{sender}} {{senderShort}} {{senderId}} {{conversationId}} {{messageId}} {{taskId}}

Comments like this one are stripped; the agent never sees them.
-->
`;

export function registerPromptCommand(program: Command): void {
  const prompt = program
    .command("prompt")
    .description("Customize the prompt an incoming channel message becomes in every agent");

  prompt
    .command("init")
    .description(`Write the built-in template to ${globalPromptTemplatePath()} to edit it`)
    .option("--force", "Overwrite an existing template")
    .action((options: { force?: boolean }) => {
      const path = globalPromptTemplatePath();
      if (existsSync(path) && !options.force) {
        console.error(chalk.yellow("!") + ` ${path} already exists — edit it, or pass --force to start over.`);
        process.exitCode = 1;
        return;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${PLACEHOLDERS}\n${DEFAULT_PROMPT_TEMPLATE}\n`);
      console.log(chalk.green("✓") + ` Wrote ${path} — every agent uses it from its next message.`);
    });

  prompt
    .command("show")
    .description("Show which template is in effect and a sample message rendered with it")
    .action(() => {
      const path = promptTemplatePath();
      const template = loadPromptTemplate();
      console.log(chalk.bold("Template: ") + (path ?? "built-in"));
      for (const w of template ? promptTemplateWarnings(template) : []) console.log(chalk.yellow("  ! ") + w);
      const sample = {
        conversationId: "conv-example",
        messageId: "msg-example",
        fromAgentId: "client-claude-code-0123456789ab",
        fromAgentName: "claude-code",
        content: "Can you run the tests and tell me what fails?",
      } as ChannelMessage;
      console.log(chalk.dim("\n─── sample (reply required) ───\n"));
      console.log(buildInjectionPrompt(sample, { replyTool: "reply (open-agent-bridge MCP tool)", template }));
    });
}
