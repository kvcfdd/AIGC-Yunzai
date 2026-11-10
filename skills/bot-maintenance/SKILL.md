---
name: bot-maintenance
description: Maintain the AIGC-Yunzai codebase itself — boot flow, plugins and events, configuration, rendering, and the AIGC subsystem. Use when changing or debugging lib/, plugins/, config/, renderers/, skills/, or when diagnosing bot startup and chat failures.
tools: read, write, edit, glob, grep, pwsh, bash
---

# Bot maintenance

This skill is the maintenance entry point for AIGC-Yunzai. Classify the task first, then load only the reference you need. Do not load every reference up front.

## Reference map

| Task | Read |
| --- | --- |
| Boot flow, directory responsibilities, events and plugins, config and storage, rendering, AIGC layers | `references/architecture.md` |
| Editing code, adding plugins/tools/skills/MCP servers, config changes, verification and formatting | `references/development.md` |
| Startup failures, messages not triggering, AIGC not replying, renderer or database errors | `references/troubleshooting.md` |

## Hard constraints

- Make the smallest change that solves the task. Do not refactor, reformat, or "clean up" unrelated files.
- Never restart, stop, or force-kill the bot unless the operator explicitly asks. Code under `lib/` and plugins using `index.js` are not hot-reloaded — report that a restart is required instead of restarting.
- Never run `git reset --hard`, `git clean`, `rm -rf`, or force-push. `plugins/other/maint_task.js` can run `git reset --hard @{u}` on configured paths, destroying uncommitted work.
- Never print, copy, or write API keys, cookies, or full user logs. Quote only the necessary lines when diagnosing.
- Change shipped defaults in `config/default_config/`. `config/config/` is the live copy; edit it only when the operator asks.
- Do not run a repo-wide `pnpm lint` during diagnosis — prettier rewrites every JS file. Format only changed files.
- Do not expose or weaken WebUI authentication, and do not bind services to the public internet.
- Shell tooling is platform-selected: the bot registers `pwsh` on Windows and `bash` elsewhere. Only one exists at runtime; use the registered one and do not assume both are callable.
- Write commit messages in Chinese. Do not commit or push unless asked.

## Workflow

1. State whether the task is locate / modify / diagnose, then pick the matching reference.
2. Locate entry points with `glob` and `grep`; read only the relevant sections with `read`. Check how neighboring code already does it.
3. Before editing, identify: callers, config keys, data compatibility, master-only constraints, and whether a restart is needed.
4. Follow project style: ESM, no build step, `semi: false`, double quotes, printWidth 500, Chinese comments.
5. Verify with `node --check <file>`, re-read the affected code paths, and use logs where behavior is runtime-dependent. Never claim a fix without actual check output.
6. Report: files changed, why, verification output, restart requirement, and remaining risks.

## Where to start

- Boot and core: `app.js`, `lib/bot.js`
- Plugin loading and matching: `lib/plugins/loader.js`, `lib/plugins/plugin.js`
- Events and listeners: `lib/events/`, `lib/listener/`
- AIGC entry: `plugins/system/aigc.js`, `lib/ai_core/index.js`
- Defaults: `config/default_config/*.yaml`; live config: `config/config/*.yaml`
- Data: `data/db/data.db`; logs: `logs/error.log`, `logs/command/`

## Stop and ask

- The task requires restarting or stopping the live bot, or editing live values in `config/config/`.
- The task requires deleting data, resetting git, overwriting uncommitted work, changing authentication, or exposing a port.
- The task requires committing or pushing, or a secret may have leaked.
- Code behavior conflicts with the docs and neither the code nor logs can decide the answer.
