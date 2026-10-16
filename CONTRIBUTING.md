# Contributing to open-agent-bridge

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

- **Small fixes** (typos, an obvious bug with a clear fix): open a pull request directly.
- **Features or behavior changes**: open an issue first with the problem and the approach you have in mind. Agreeing on the shape before the code saves both of us a rewrite.
- **Security issues**: do not open a public issue with details. Use GitHub's private vulnerability reporting (repository **Security** tab → *Report a vulnerability*).

## Reporting a bug

Please include:

- What you ran, what you expected, and what happened instead.
- `oab --version` (or the commit you built from), your OS and `node --version`.
- The versions of the clients involved, for example `claude --version`, `codex --version`, `opencode --version`, `pi --version` and `agy --version`.
- The output of `oab doctor` and `oab list`.
- Relevant logs:
  - the MCP adapter writes to the client's MCP log;
  - `oab codex start` prints its log path (`/tmp/open-agent-bridge-codex-<pid>.log`);
  - the registry logs to its terminal; the background daemon (`oab up`) writes `.open-agent-bridge/registry.log` in the directory it was started from.

Strip secrets before posting. `CLAUDE_CODE_MESSAGING_TOKEN` and `ANTIGRAVITY_CSRF_TOKEN` are credentials (the latter is also stored in `$XDG_RUNTIME_DIR/open-agent-bridge/agy-<pid>.json`), and paths can reveal private project names.

## Development setup

Requirements: Node.js ≥ 22 and pnpm 10.

```bash
git clone https://github.com/kevinArgueta96/open-agent-bridge.git
cd open-agent-bridge
pnpm install
pnpm build
```

- `pnpm dev -- <command>` runs the CLI straight from `src/` (for example `pnpm dev -- list`).
- `bash bin/install.sh` builds everything and puts your local `oab` / `open-agent-bridge` on the PATH, so real agent sessions use your build. Restart those sessions after rebuilding: each one keeps the adapter code it started with. The OpenCode plugin and the pi extension are copies — rerun `oab opencode install-plugin` / `oab pi install-extension` after changing them (OpenCode 2 reloads its plugin when the file changes).
- `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, so pnpm will not install a dependency version published less than 24 hours ago. That is intentional.
- The dashboard is a separate Vue app: `pnpm build:dashboard`, or `pnpm build:all` for everything.

[`docs/development.md`](docs/development.md) has the longer guide: repository layout, builds, and a manual verification checklist.

## Checks — the same ones CI runs

```bash
pnpm build
pnpm test
pnpm biome check src/ --diagnostic-level=error
```

`pnpm lint` shows warnings and infos too. Fix the ones you touch, but only errors fail CI.

**Running the tests from inside an agent session.** A Claude Code session exports `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` to every child process, including your test runner. Unset them so no test can write into your live session:

```bash
env -u CLAUDE_CODE_MESSAGING_SOCKET -u CLAUDE_CODE_MESSAGING_TOKEN pnpm test
```

### Writing tests

- Vitest. Only `src/**/*.test.ts` is collected — the compiled copies in `dist/` are excluded on purpose.
- New logic that branches, parses, loops or touches delivery needs at least one test that fails if it breaks. One-liners don't.
- Never point a test at the live registry on `:4999` or at a real inbox socket (Claude Code's, or the host inbox sockets under `$XDG_RUNTIME_DIR/open-agent-bridge/`):
  - use a temp directory;
  - set `HOME` to it, because the registry database lives under `~/.open-agent-bridge/`;
  - use another port;
  - use a socket server you create yourself, or point `XDG_RUNTIME_DIR` at the temp directory.
- Unix socket paths are capped at about 108 bytes. Keep temp socket paths short.
- Never print or log a token's value (`CLAUDE_CODE_MESSAGING_TOKEN`, `ANTIGRAVITY_CSRF_TOKEN`) — only its name or whether it is present.

### Trying delivery end to end

Two or three terminals on the same identity, in different projects. Run `oab init --yes --client claude,codex --identity e2e` once in each project, then:

```bash
claude      # terminal 1, project A
claude      # terminal 2, project B
codex       # optional: terminal 3, project C (codex ≥ 0.162)
```

`oab doctor` should show both `client: claude (native push)` and `client: codex (native push)` in green first. To include OpenCode, pi or agy, install their in-host piece once (`oab opencode install-plugin`, `oab pi install-extension`, `oab antigravity install-plugin`) and check their `(native push)` line too.

Ask the first session to message the other, for example "send project B a message asking for its git branch". It should arrive in the second session as a new turn, even if that session is idle. Then its reply should arrive back as a turn in the first session. `oab list` and the dashboard (`http://localhost:4999/dashboard`) show peers, conversations and ACK states.

Delivery needs live agents, so a change to it is verified by hand on top of the unit tests: send a message to each affected client and check that it starts a turn there, that the client answers with `reply`, and that it can send with `message_client_session`.

## Code guidelines

- TypeScript strict, ESM, Node built-ins first. Discuss a new runtime dependency in an issue before adding it.
- Keep changes small and focused, and match the surrounding code. Comments explain *why*, not what.
- Client-specific behavior lives in its own module under `src/client/` (one per client: Claude Code, Codex, OpenCode, pi, Antigravity). Undocumented or unstable client APIs stay isolated in a single file, so a client upgrade breaks one place.
- The injection prompt lives only in `src/client/injection-prompt.ts`; the adapter wraps every message before it reaches a client. `src/__tests__/injection-prompt.test.ts` locks the contract.
- `listenHostInbox` has three copies, because the OpenCode plugin and the pi extension are installed as standalone files:
  - `src/client/host-inbox-socket.ts`;
  - `src/client/opencode-plugin/agent-bridge.ts`;
  - `src/client/pi-extension/agent-bridge.ts`.

  Keep them in sync, including the message-id dedupe.
- The OpenCode plugin ships as two files: `agent-bridge.ts` (installed as `index.ts`, the server half) and `tui.ts` (the terminal half). The build copies both to `dist/`.
- agy reads `plugins/open-agent-bridge/hooks.json` (agy's hook format) from the plugin root; Claude Code and Codex read `plugins/open-agent-bridge/hooks/hooks.json`. They are different files on purpose.
- User-visible changes update the docs in the same pull request:
  - `README.md`;
  - `docs/cli-reference.md` for commands and flags;
  - `plugins/open-agent-bridge/skills/agent-bridge/SKILL.md` if agents should behave differently.

## Commits and pull requests

- Branch from `production` and open the pull request against `production`.
- Use conventional commits with the area as scope, for example:
  - `fix(codex): reconnect when the app-server WebSocket drops`
  - `feat(cli): …`
  - `docs: …`
  
  Common scopes: `claude`, `codex`, `opencode`, `pi`, `antigravity`, `delivery`, `cli`, `registry`, `plugin`, `dashboard`, `prompt`.
- The commit body explains why the change is needed.
- The PR description covers:
  - the problem;
  - the approach;
  - how you tested it (commands and their output);
  - screenshots for dashboard changes.
- CI must be green before review.

## Project map

| Path | What lives there |
| :--- | :--- |
| `src/registry/` | Registry daemon: HTTP + WebSocket API, SQLite channel store |
| `src/mcp/adapter.ts` | MCP adapter each client session spawns; tools and per-client delivery |
| `src/client/` | Per-client delivery and helpers (Claude inbox socket, Codex daemon, host inbox socket, OpenCode plugin, pi extension, agy language server) |
| `src/cli/commands/` | One file per `oab` command |
| `plugins/open-agent-bridge/` | Plugin for Claude Code, Codex and agy: MCP entry, skill, commands, hooks |
| `dashboard/` | Vue 3 dashboard served by the registry |
| `docs/` | Longer-form docs (Spanish): architecture, messaging flow, CLI reference |

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
