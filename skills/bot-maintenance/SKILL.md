---
name: bot-maintenance
description: Diagnose bot errors, fix code or config, and add plugins, AIGC tools, or skills.
tools: read, write, edit, glob, grep, pwsh
master_only: true
---

# Bot maintenance

Use this skill when the operator asks you to diagnose or change this bot. Work from the repository root; the process requires it as CWD. Do not assume a `CLAUDE.md` exists: this skill and its references are the maintenance source of truth.

## Operating loop

1. Classify the failure: AIGC model/tool, plugin, adapter, config, renderer, database/Redis, or MCP.
2. Read the smallest relevant source and log excerpt. Do not dump whole files or logs.
3. State a concrete hypothesis and the evidence for it before editing.
4. Make the smallest correct change.
6. Report the change, verification output, and remaining risk. Never claim a fix without passing verification.

## Repository map

- `app.js` → `lib/bot.js` boot; `lib/ai_core/` is the AI subsystem.
- `lib/plugins/loader.js` discovers plugins in `plugins/` and dispatches rules.
- `lib/config/config.js` loads YAML; `config/default_config/` are tracked defaults; `config/config/` are live, gitignored, hot-reloaded copies.
- `data/` is gitignored runtime state: SQLite `data/db/data.db`, AIGC media, plugin data.
- `lib/redis/` is a Redis-v4-compatible client over SQLite; there is no Redis server.
- `lib/renderer/browser.js` is the shared Playwright Chromium singleton; renderer backends live in `renderers/`.

## Commands

```sh
node .                 # foreground
node . dev             # foreground + render data in temp/ViewData
node . stop            # stop via HTTP /exit
node . daemon          # supervisor, restarts on exit code 255
pnpm start|stop|restart|log
npx prettier --write <changed files>
```

Never run repo-wide `pnpm lint` while diagnosing; it rewrites every JS file.

## Where to look next

- `references/architecture.md` — boot flow, plugin system, config/data, AIGC layers and public API.
- `references/development.md` — add a plugin, an AIGC tool, or a skill; tests and formatting.
- `references/troubleshooting.md` — logs, common error patterns, restart and safe-operation rules.

Read only the reference needed for the current task.

## Safety

- Do not run `git reset --hard`, `git clean`, `rm -rf`, or bot stop/restart unless the operator explicitly asks. The scheduled maintenance task can reset plugin repositories.
- Never print, copy, or commit API keys from `config/config/*.yaml`.
- Do not overwrite live config; change `config/default_config/` and tell the operator what to merge, unless they asked for the live copy.
- Code under `lib/` is not hot-reloaded: report that a restart is required; do not kill the process yourself.
- If verification fails, revert only your own change; never discard unrelated work.
