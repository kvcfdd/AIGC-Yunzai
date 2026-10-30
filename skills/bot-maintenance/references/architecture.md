# Architecture

This repository is AIGC-Yunzai, a fork of TRSS-Yunzai. Node.js ESM, no build step; source runs directly. The process must run with the repository root as CWD: the plugin loader scans `./plugins`, listeners scan `./lib/events`, and relative data paths resolve from there.

## Boot flow

`app.js` parses `stop|daemon|pm2|start` (default internal), sets `global.Bot = new Bot()`, then calls `Bot.run()` in `lib/bot.js`:

1. config and logger init
2. `lib/ai_core` init (including MCP servers)
3. HTTP/WS server on port 2536
4. `PluginsLoader.load()`
5. `ListenerLoader.load()`
6. `emit("online")`

`Bot` is a Proxy over `Bot.bots`. Unknown properties fall through to `lib/util.js` helpers or resolve to a random logged-in account. Each connected account is a `Bot[self_id]` object with `pickFriend`, `pickGroup`, and `sendApi`.

Adapters emit `Bot.em("<post_type>.<message_type>.<sub_type>", data)`. Parent prefixes also fire, so `event: "message"` catches every message subtype. Listeners are not awaited; events are processed concurrently.

## Plugin system (`lib/plugins/loader.js`)

- Discovery: only direct subdirectories of `plugins/`.
- If `plugins/<dir>/index.js` exists, only that file is imported and it gets **no hot reload**.
- Otherwise every top-level `.js` file in the directory is a plugin file and is watched by chokidar (5s debounce, `cfg.bot.file_watch`).
- A plugin is a class extending the global `plugin`:

```js
export default class Foo extends plugin {
  constructor() {
    super({ name, dsc, event: "message", priority: 5000, rule: [{ reg, fnc, permission }], task: [{ name, fnc, cron }] })
  }
}
```

- Classes are instantiated twice at load time plus once per matching event. Never do work in the constructor.
- `init()` runs once; return the string `"return"` to skip loading the plugin.
- `priority` is ascending (lower runs earlier), default 5000.
- A string `rule.reg` is compiled to RegExp. `rule.event` supports wildcard segments such as `notice.group.*`.
- Handler return semantics: `return false` keeps matching later rules/plugins; any other value, including `undefined`, consumes the event.
- The event object `e` exposes `msg`, `img[]`, `at`, `atBot`, `file`, `reply_id`/`getReply()`, `isGroup`/`isPrivate`, `isMaster`, `runtime` (render and user info helpers), and a wrapped `reply()`.
- Multi-step conversations use `setContext`/`getContext`/`finish` on the plugin instance.
- Plugin-owned config: `makeConfig(name, defaults)` in `lib/plugins/config.js` creates/merges `config/<name>.yaml`.

## Globals and config

Globals: `Bot`, `plugin`, `segment`, `logger`, `redis`.

Config is imported, not global: `import cfg from "../lib/config/config.js"`. `cfg.<name>` resolves `config/config/<name>.yaml` merged over `config/default_config/<name>.yaml` and hot-reloads on change. `cfg.master` / `cfg.masterQQ` hold master accounts.

Tracked defaults live in `config/default_config/*.yaml` (bot, group, other, server, renderer, db, aigc, maint_task). Live copies in `config/config/*.yaml` are gitignored and hot-reloaded. On startup, missing keys from the defaults are merged into the live copies (existing values and YAML comments are preserved) by `lib/config/merge-default.js`.

`data/` is entirely gitignored runtime state: SQLite `data/db/data.db`, `data/aigc/*` (chat media, renders), and game-plugin data.

## Database

`global.redis` (`lib/config/redis.js` → `lib/redis/`) is a node-redis-v4-compatible client over SQLite tables `redis_kv`, `redis_hash`, `redis_zset`, `redis_set`, `redis_list`, and `redis_expires` in `data/db/data.db`. Lazy expiry on read, a background sweeper, and incremental vacuum. Unsupported commands throw loudly; `multi().exec()` runs in one transaction.

`lib/db.js` plus `lib/sqlite-conn.cjs` provide process-global shared better-sqlite3 connections (WAL, `busy_timeout`). Legacy `sqlite3`/sequelize shims live in `lib/modules/` and are pnpm-linked.

## Rendering

Playwright Chromium is a process-wide singleton in `lib/renderer/browser.js`. All access must go through `browser.runTask(fn)`; direct Chromium access is refused. It enforces `renderer.browser.concurrency`, restarts the browser after `restartNum` tasks, and closes it after `idleTime` idle minutes. Callers must close their own browser contexts.

Renderer backends are plugins in `renderers/<id>/index.js`: `playwright` (default) and `server` (adds `POST /render`, configured by `renderer.yaml`, disabled by default).

`e.runtime.render(plugin, path, data, cfg)` goes through `lib/puppeteer/puppeteer.js` to the renderer and returns `segment.image`. `node . dev` dumps render data to `temp/ViewData/` for `pnpm web`. `resources/` is gitignored; plugins ship their own resources.

## Adapters (`plugins/adapter/`)

Adapters self-register by pushing into `Bot.adapter` at import time; `ListenerLoader` calls `adapter.load()`.

- `OneBotv11.js`: reverse WS server on `/OneBotv11`, always enabled; dedups messages and tracks pending `sendApi` promises by `echo`.
- `GSUIDClient.js`: outbound WS client to 早柚核心, gated by `cfg.gsuid.enable`.
- `stdin.js`: console pseudo-bot, only when stdin is a TTY.

## AIGC subsystem (`lib/ai_core/`)

`Bot.aigc` exposes `provider`, `memory` (alias `conversation`), `tools`, `mcp`, `skills`, `voice`, `requestScheduler` (alias `coordinator`), `dialogue`, `schedule`, and `injectMessage`. The user-facing plugin is `plugins/system/aigc.js`, priority `999999999` (runs last) with a catch-all rule.

Layers:

- **Perception** (`perception/`): trigger gating (`trigger.js`), event → turns (`turn-input.js`), system prompt (`system-prompt.js`), injected events (`injected-event.js`), message text/history formatting (`message-format.js`), media preprocessing (`media-resolver.js`).
- **LLM** (`llm/`): provider facade and adapters (`gemini/`, `openai/`, `anthropic/`, `responses/`), API key rotation (`api-keys.js`), errors, message builders (`message-builders.js`), model config resolution (`model-config.js`), proxy dispatch (`network-proxy.js`), retry helpers, media capabilities, audio conversion.
- **Core** (`core/`): `dialogue.js` single-turn orchestration, `tool-loop.js` tool-call loop, `request-scheduler.js` request merge/queue/abort.
- **Tools** (`tools/`): `tool-registry.js`, built-ins in `tools/builtin/`, MCP in `tools/mcp/`, skills in `tools/skills/`. Tools receive `createToolContext` from `tool-context.js`; results are normalized by `tool-result.js`.
- **Memory** (`memory/`): SQLite conversation history plus FTS5 search (`sqlite-store.js`, `conversation-history.js`, `schema.js`, `aigc_message_fts`), semantic index (`semantic-store.js`, sqlite-vec `aigc_turn_vec` partitioned by user; embeddings in `lib/ai_core/embeddings/`), persistent file memory (`persistent-store.js`: `data/aigc/memory/MEMORY.md` and per-user/group profiles), persistence serialization. Tools: `memory_search` (`auto`/`keyword`/`semantic`), `memory_update` (`append`/`replace`/`remove`; empty memory injects a short write hint, non-empty memory is injected with per-file usage). Clearing or pruning a session also purges its semantic index; config under `aigc.memory` and `aigc.embeddings`.
- **Output** (`output/`): text-or-voice reply protocol (text split by `<xix>`, a single `<voice>` reply, never mixed) / `no_reply`, voice text sanitizing, @/face conversion, TTS, sending, and turn trace forwarding (`turn-trace.js`). TTS is a provider registry under `output/tts/` selected by `aigc.voice.provider` (wusound, openai, gemini, minimax, elevenlabs, azure, volcengine, mimo, fishaudio, dashscope Qwen TTS); per-provider settings live under `aigc.voice.providers.<name>`.
- **Media** (`media/`): download/cache, size limits, image downscale/slicing, GIF→MP4, silk→WAV, office docs→text.

Triggering: `cfg.aigc.enable` (default false), per-user/group whitelists/blacklists, @bot in groups, ambient chat (`aigc.proactive_group_chat.probability`, percent; 0 disables), private chat via `aigc.private_chat_enable` plus friend check.

Provider: model configs live in `aigc.models[]`. `name` selects the config; `api` is the built-in interface type selected at each usage site. Default entries: `gemini`, `openai`, `anthropic`, `responses`. `api_keys` rotates round-robin per channel. Model-using sites select config + API: main `model_config`/`api`, `aigc.proactive_group_chat.model_config`/`api`, and `aigc.agent.model_config`/`api`; unset values inherit the global default. Channels: `main`, `ambient`, `agent`.

Memory: turn-based rows in SQLite table `aigc_message`; FTS5 (`aigc_message_fts`, trigram) backs the `memory_search` tool and falls back to LIKE for terms under 3 characters. When `aigc.embeddings` is enabled, completed turns are embedded asynchronously into sqlite-vec (`aigc_turn_vec`, per-user partition); `memory_search` auto mode merges keyword and semantic results with RRF, missing turns are backfilled on demand, and changing model/dimension clears the index. Persistent file memory (`data/aigc/memory/MEMORY.md`, `users/<qq>.md`, `groups/<gid>.md`) is injected as `<persistent_memory>` inside the per-turn `<runtime_context>` and written by `memory_update`; ambient chat skips the personal profile. The context window is a sawtooth: accumulate up to `context_rounds` turns, then keep only the latest `context_keep_rounds` turns and grow again; history is never rewritten, and tools report missing media files as expired. Same-user requests of the same type abort and merge the previous one.

Chat engine: `core/dialogue.js` plus `core/tool-loop.js` run the tool-call loop (`max_tool_rounds`), persist per-round API deltas atomically, and forward the whole turn process via `output/turn-trace.js` when `aigc.show_thinking` is on. `perception/injected-event.js` plus `Bot.aigc.injectMessage` lets external callers inject a synthetic user message with an optional `source` (`schedule`/`agent`), which drives runtime hints and is persisted as `inject_source`.

Config WebUI: `lib/webui/` serves an Apple-style vanilla SPA at `/aigc_yunzai` (mounted from `lib/bot.js` after `serverLoad`). It auto-enumerates core configs (`config/default_config` + `config/config`), root plugin configs (`config/*.yaml` from `makeConfig`), plugin-dir configs (`plugins/<dir>/config/**/*.yaml`), and runtime configs (`data/<plugin>/config/**/*.yaml`), using `defSet/**` / `defaultConfig/**` for defaults and comments. It matches plugin files to `plugins/*/package.json`, infers controls from YAML types, uses key comments as labels/hints, and auto-generates the form (objects → grouped cards, booleans → switches, arrays of primitives → list editors, arrays of objects → collapsible item forms with an advanced-JSON fallback, nulls → free-form values). Patches are validated against the existing tree and written comment-preservingly; raw YAML per file is available. Plugin-dir/runtime configs are flagged as possibly overwritten by plugin updates. API routes require the one-time key login (`#登录`/`#登陆`; 10-minute single-use key, 12-hour HttpOnly session cookie; static assets public; non-master messages are ignored); scope is config editing only, not plugin install/update. Special miao help entry (`special:miao-help`) loads `plugins/miao-plugin/config/help.js` or `help_default.js`, edits `helpCfg`/`helpList` structurally, copies the default to `help.js` on first save when missing, and offers a JS source mode.

Tools: `web_search`, `web_fetch` (`http` default / `playwright`), `fetch_media`, `send_media` (local paths only), `interact_user`, `memory_search`, `memory_update`, `skill`, and master-only `read`, `write`, `edit`, `glob`, `grep`, `pwsh`/`bash` confined to the project root. Deferred tools are listed compactly in `<on_demand_tools>` and loaded per turn via `tool_search`: `block_user`, `group_admin`, `schedule_task`, `agent`, `user_info`, and MCP tools.

Skills: built-in `skills/<name>/SKILL.md` (tracked) and user `data/skills/<name>/SKILL.md`; user skills override built-ins by name. Frontmatter `name`/`description`/`tools`; `master_only: true` hides a skill from non-master users. The `skill` tool returns the body, declared tools, and the skill directory file tree.

MCP: `tools/mcp/manager.js` uses the official `@modelcontextprotocol/client` v2 (Streamable HTTP / SSE / stdio). Servers live under `aigc.mcp.servers`, exposed as `mcp_<name>` deferred tools: they appear in `<on_demand_tools>` and are loaded with `tool_search` before use.

## Gotchas

- CWD must be the repository root.
- `plugins/*` is gitignored except `adapter/`, `system/`, `other/`, `example/`. miao-plugin and yuki-plugin are their own git repos.
- `#更新` (`plugins/other/update.js`) runs `git pull` on the repo root and each plugin repo. `plugins/other/maint_task.js` periodically runs `git reset --hard @{u}` on configured paths; uncommitted work there can be destroyed.
- Commit messages in this repository are written in Chinese.
