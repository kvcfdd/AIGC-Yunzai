# Architecture reference

Read this when you need to know where code lives or how a request flows. For how to change code, read `development.md`; for failures, read `troubleshooting.md`.

## 1. Runtime and boot

- Node >= 24.16. Pure ESM, no build step; source runs directly.
- Start from the repository root. Plugin discovery (`./plugins`), event discovery (`./lib/events`), config, and data paths are all relative to the process cwd.
- `app.js` selects a mode from `process.env.app_type || process.argv[2]`:
  - default: internal start (`global.start_type = "internal"`).
  - `start`: external start, used by pm2 or the daemon child (`"external"`).
  - `pm2`: pm2 start (`"pm2"`).
  - `daemon`: supervisor. It restarts the child for any exit code except `255`; exit code `255` stops the supervisor.
  - `stop`: reads the configured port and requests `http://localhost:<port>/exit`, then exits. The `/exit` handler only accepts loopback clients.
- `Bot.run()` order (`lib/bot.js`):
  1. `lib/config/init.js` — logging, timezone `Asia/Shanghai`, signal and unhandled-error handlers, SQLite-backed Redis init.
  2. Import `lib/ai_core/index.js` into `Bot.aigc`; run `mcp.init()`; run `schedule.init({ inject: aigc.injectMessage })`.
  3. Listen on `cfg.server.port` (default `2536`) for HTTP/WS; mount the WebUI at `/yunzai` (legacy `/aigc_yunzai` redirects).
  4. Start HTTPS when `cfg.server.https.key` and `cert` are configured.
  5. `PluginsLoader.load()`.
  6. `ListenerLoader.load()` — imports `lib/events/*.js`, then calls `load()` on each adapter registered in `Bot.adapter`.
  7. Set `stat.online = 2` and emit `online`.
- Globals: `Bot`, `plugin`, `segment`, `logger`, `redis`, `Renderer`. Configuration is not global; import `cfg` from `lib/config/config.js`.
- `Bot` is a Proxy. Unknown properties fall through to `lib/util.js` helpers, then to a randomly chosen logged-in account. Each account is `Bot[self_id]` with `pickFriend`, `pickGroup`, and `sendApi`.

## 2. Directory map

| Path | Responsibility |
| --- | --- |
| `app.js` | Mode selection and process entry |
| `lib/bot.js` | Bot singleton, HTTP/WS server, event emission, boot order |
| `lib/config/` | Config load/merge/watch, logging, SQLite Redis init |
| `lib/plugins/` | Plugin base class, loader, runtime, handler, `makeConfig` |
| `lib/events/`, `lib/listener/` | System listeners and listener loader |
| `lib/ai_core/` | AIGC subsystem |
| `lib/renderer/`, `renderers/` | Browser singleton and render backends |
| `lib/puppeteer/` | Legacy render compatibility layer |
| `lib/webui/` | Config WebUI at `/yunzai` |
| `plugins/` | Bot plugins; only `adapter/`, `system/`, `other/`, `example/` are tracked by git |
| `config/default_config/` | Tracked shipped defaults |
| `config/config/` | Live config (gitignored, hot-reloaded) |
| `data/` | SQLite, AIGC media/memory/knowledge, plugin data (gitignored) |
| `skills/` | Built-in AIGC skills |
| `logs/` | `error.log`, `command/YYYY-MM-DD.log` |
| `temp/` | Scratch files and `temp/ViewData` render dumps |

## 3. Event model and message flow

- Adapters (`plugins/adapter/*.js`) self-register into `Bot.adapter` at import time. `OneBotv11` accepts reverse WebSocket connections at `/OneBotv11`; `GSUIDClient` opens an outbound WS gated by `cfg.gsuid.enable`; `stdin` is TTY-only.
- Adapters call `Bot.em("<post_type>.<message_type>.<sub_type>", data)`. `Bot.em` first enriches the event with `bot`, `friend`, `group`, `member`, and `reply`, then emits the full name and every parent prefix: `message.group.normal` → `message.group` → `message`.
- Listeners are not awaited; events are processed concurrently.
- `lib/events/message.js`, `notice.js`, and `request.js` subscribe to their parent event and call `PluginsLoader.deal(e)`.
- `deal(e)` pipeline:
  1. Message counters.
  2. Blacklist/whitelist checks from `cfg.getOther()`.
  3. Cooldown, mute, and 1-second duplicate throttle.
  4. `dealEvent(e)` — assembles `e.msg` from text/XML/JSON segments, collects `e.img`, `e.video`, `e.audio`, `e.at`, `e.atBot`, `e.file`, `e.reply_id`; sets `isPrivate`/`isGroup`/`isMaster`; strips a configured `botAlias`; computes `e.only_reply_at`.
  5. Wraps `e.reply` with quote/at/recall support and send-error logging.
  6. Initializes `e.runtime`.
  7. Builds the priority list, filtered by group `enable`/`disable` (matched against plugin `name`).
  8. Runs stored context hooks (`setContext` / `getContext`).
  9. **If `only_reply_at` is false, returns here.** Rules and the AIGC catch-all never see that message.
  10. Runs `accept` hooks, then rules in ascending priority order.
- Rule matching: rule-level `event` first, then the rule regex against `e.msg`, then permission. If a handler returns `false`, matching continues with later rules/plugins; any other return value (including `undefined`) consumes the event. Exceptions are logged and also consume the event.
- Useful event fields: `msg`, `img`, `at`, `atBot`, `file`, `isGroup`, `isPrivate`, `isMaster`, `runtime`, `reply()`, plus `self_id`, `user_id`, `group_id`, `sender`, `member`, `group`, `friend`.

## 4. Plugin system

- Discovery is one level deep in `plugins/`:
  - If `plugins/<dir>/index.js` exists, only that file is imported and it gets **no hot reload**.
  - Otherwise every top-level `.js` file in the directory is a plugin and is watched by chokidar with a 5-second debounce.
- A plugin is a class extending the global `plugin`. Constructor options: `{ name, dsc, handler, namespace, event = "message", priority = 5000, task, rule }`.
- Lifecycle: the loader instantiates the class once to run `init()` (return `"return"` to skip registration), then instantiates it again for the registry. Each matching event instantiates the class again. **Never do work or side effects in the constructor.**
- `priority` is ascending; default `5000`.
- `rule` entries: `{ reg, fnc, event, log, permission }`. A string `reg` is compiled to `RegExp`. A rule-level `event` is an additional filter on top of the plugin-level event and supports wildcards such as `notice.group.*`.
- `permission`: `"master"`, `"owner"`, or `"admin"`. Masters bypass all checks.
- `task`: one object or an array of `{ name, cron, fnc, log }`, scheduled with node-schedule.
- `handler`: registers `{ fn, key, priority }` entries into `lib/plugins/handler.js` under `namespace`.
- Multi-step dialogs use `setContext(type, isGroup, time, timeout)`, `getContext(type, isGroup)`, `finish(type, isGroup)`, and `awaitContext(...)`.
- Plugin config: `makeConfig(name, defaults)` (`lib/plugins/config.js`) creates and merges `config/<name>.yaml`; it is separate from `config/config/`.

## 5. Config, storage, and runtime data

- `cfg` is a Proxy: known properties win; unknown properties resolve through `getAllCfg(name)`, a shallow merge of `config/default_config/<name>.yaml` over `config/config/<name>.yaml`.
- Startup copies missing default files into `config/config/` and merges missing default keys into existing live files, preserving comments (`lib/config/merge-default.js`).
- Live config files are watched with chokidar and a 5-second debounce; the cache entry is invalidated. `cfg.setConfig(name, key, value)` writes the live YAML and invalidates the cache.
- Masters: `other.master` holds `bot_id:user_id` entries; `cfg.master` exposes `{ bot_id: [user_id] }`; `cfg.masterQQ` is the flat list. `isMaster` is set when `e.user_id` appears under `cfg.master[e.self_id]`.
- Group config layering (`cfg.getGroup(bot_id, group_id)`): `default` → `<bot_id>:default` → `<group_id>` → `<bot_id>:<group_id>`.
- SQLite default path is `data/db/data.db` (`cfg.db.storage` overrides). `lib/db.js` and `lib/sqlite-conn.cjs` provide a shared write connection with WAL and busy timeout.
- `global.redis` is a Redis-v4-compatible client backed by SQLite tables under `lib/redis/`; there is no external Redis server.
- AIGC data paths:
  - `data/aigc/chat` — downloaded media cache
  - `data/aigc/tmp` — conversion scratch space
  - `data/aigc/memory` — persistent file memory
  - `data/aigc/knowledge/kb.db` — knowledge base
  - `data/aigc/tts` — TTS output
- Logs: `logs/error.log`; daily command logs under `logs/command/`.

## 6. Rendering

- `lib/renderer/browser.js` owns a process-wide Playwright Chromium singleton.
- All access must go through `browser.runTask(fn)`. Direct `getBrowser()` outside a task throws. Callers must close their own browser contexts.
- It enforces `renderer.browser.concurrency`, restarts the browser after `restartNum` tasks, and closes it after `idleTime` idle minutes. Nested `runTask` calls execute inline to avoid deadlock.
- Backends live in `renderers/<id>/index.js`; each default-exports a factory. The loader registers by `id`; `playwright` is the default backend. The `server` backend adds `POST /render` on port `1134`, disabled by default; enabling it requires a restart.
- `lib/puppeteer/puppeteer.js` keeps the legacy `screenshot` / `screenshots` helpers.
- `e.runtime.render(plugin, path, data, cfg)` renders through `lib/puppeteer/puppeteer.js`; `cfg.retType` can be default (send image), `msgId`, or `base64`.
- `node . dev` dumps render data to `temp/ViewData/`.

## 7. AIGC subsystem

### 7.1 Public API

`lib/ai_core/index.js` exposes `Bot.aigc`: `provider`, `memory` (alias `conversation`), `tools`, `mcp`, `skills`, `knowledge`, `voice`, `requestScheduler` (alias `coordinator`), `dialogue`, `schedule`, `config`, `AigcError`, and `injectMessage`. It is initialized before plugins load.

### 7.2 Entry and trigger

- `plugins/system/aigc.js` has priority `999999999` and a catch-all rule, plus `#开启aigc`, `#关闭aigc`, `#结束对话`, and master-only `#结束全部对话`.
- `accept()` handles a bare `@bot` only when `aigc.reply_on_bare_at` is true.
- `evaluateTrigger` (`perception/trigger.js`) gates on:
  - `aigc.enable` (default `false`).
  - Private chat: `private_chat_enable`, and the sender must be in the bot's real friend list (`event.bot.fl`); protocol-side public-account pushes are not friends.
  - `aigc.qq_blacklist`, `aigc.group_whitelist`.
  - Group ambient chat: `proactive_group_chat.probability` (0–100), a 5-minute Redis cooldown keyed `aigc:ambient:cd:<group_id>`, and no active request for that event.
  - `aigc.prefix_filter` for non-injected messages.
  - Group `only_reply_at` must already have admitted the message, or `deal()` never reaches the AIGC plugin.

### 7.3 One turn

1. `dialogue.run` → `runTurn`.
2. `requestScheduler` merges or queues: same-user user requests abort and merge; injected requests queue behind user requests instead of aborting; new input during tool execution/compaction is appended to the running request.
3. Build the turn, reply sender, system prompt, and knowledge query.
4. Resolve model config for the channel: `main` uses `aigc`; `ambient` uses `aigc.proactive_group_chat`.
5. Await any pending compaction, load history/context from memory, build runtime context, and resolve media.
6. Run the tool loop up to `max_tool_rounds` (clamped 2–150; default 30).
7. Handle blocked/empty/failed results, parse reply parts, persist the round, schedule end-of-turn compaction, optionally send the turn trace, then send the reply.
8. Errors: `AbortError` means interrupted; `UNSUPPORTED_MEDIA` and model-config errors send specific user messages; other errors send a generic failure message. Injected and ambient turns fail silently.

### 7.4 Layers

| Layer | Responsibility |
| --- | --- |
| `perception/` | Trigger gating, event-to-turn conversion, system prompt, injected events, media resolution, message formatting |
| `core/` | `dialogue.js` single-turn orchestration, `tool-loop.js`, `request-scheduler.js`, `tool-compaction.js` |
| `llm/` | Provider facade and adapters (`gemini`, `openai`, `anthropic`, `responses`), key rotation, retry, model config, proxy, token usage |
| `tools/` | Registry, built-ins, MCP, skills, tool context/result normalization, workspace path safety |
| `memory/` | Append-only history, live context, daily summaries, persistent files, retention, optional embeddings |
| `output/` | Reply parsing/sending, turn tracing, voice/TTS |
| `media/` | Download/cache, size limits, image downscale, GIF→MP4, silk→WAV, office docs→text |
| `knowledge/` | Document parsing/chunking/store, hybrid retrieval, optional rerank |
| `schedule/` | Persistent scheduled tasks that inject synthetic turns |

### 7.5 Model selection

- `aigc.models[]` entries carry `name`, `base_url`, `proxy`, `api_keys`, `model`, `thinking_level`, `max_output_tokens`, `context_window`, `retry_count`, `media`, `extra_body`, and adapter-specific fields.
- Use-site selection objects (`model_config`, `adapter`, optional overrides) are resolved by `llm/model-config.js`:
  - `model_config`: use site → `aigc.model_config` → first entry.
  - `adapter`: use site → `aigc.adapter` → `gemini`.
- The selected entry supplies connection and capabilities; `adapter` selects the request implementation, not the provider.
- `aigc.multimodal` handles media the main model cannot process; `aigc.embeddings` only supports `gemini` and `openai`.
- A missing entry throws `MODEL_CONFIG_NOT_FOUND`; a missing `model` field throws `MODEL_REQUIRED`; an unknown adapter throws `UNSUPPORTED_ADAPTER`.

### 7.6 Memory and context compaction

- `aigc_message` is the append-only full history (`user`/`assistant`/`tool`/`system`, JSON `payload`). FTS5 search is exposed through `memory_search`.
- `aigc_context` is the live model window: a summary row at `turn = 0` plus recent turns.
- Compaction thresholds: 20% of `context_window` for normal users, 65% for masters, reserving output tokens. Keep `ceil(totalTurns / 10)` turns, clamped to 3–10.
- Compaction is scheduled at turn end and awaited by the next turn. The token counter is incremental, with a cold full estimate when no baseline exists.
- Optional semantic index: sqlite-vec table `aigc_turn_vec`, per user, using `aigc.embeddings`.
- Daily summaries and persistent memory files live under the memory layer; `#结束对话` clears one user's session, `#结束全部对话` clears all.
- Retention: `bot.context_retention_days` (default 30, 0 = unlimited); the AIGC plugin runs summary at `0 0 0 * * *` and pruning at `0 17 4 * * *`.

### 7.7 Tools, skills, and MCP

- Built-in tools: `web_search`, `web_fetch`, `media`, `read`, `write`, `edit`, `glob`, `grep`, `skill`, `block_user`, `group_admin`, `schedule_task`, `user_info`, `interact_user`, `memory_search`, `memory_update`, `kb_search`, plus exactly one shell tool: `pwsh` on Windows, `bash` elsewhere.
- `MASTER_ONLY_TOOLS` (`read`, `write`, `edit`, `glob`, `grep`, `pwsh`, `bash`) are listed for everyone but rejected at execution unless `ctx.event.isMaster`.
- Tool parameters must be complete JSON Schema objects; flat maps are rejected by OpenAI with HTTP 400.
- Tool results may be a string or `{ text, images, image_paths, videos, video_paths, audios, audio_paths, files, file_paths }`; other objects are JSON-stringified.
- Skills: built-in `skills/<name>/SKILL.md`; user `data/skills/<name>/SKILL.md` overrides by name. The list is cached for 60 seconds; the `skill` tool returns the body plus a file tree, and supporting files are read with the master-only `read` tool.
- MCP: servers come from `aigc.mcp.servers` (`http`, `sse`, `stdio`). Tools are registered as `mcp_<sanitized tool name>`; duplicate names overwrite. Config changes require a restart. stdio stderr is forwarded to debug logs.

### 7.8 Output protocol

- `<voice>text</voice>`: send one voice message; the first non-empty voice block wins and all text is ignored.
- `<xix>`: split plain text into multiple messages.
- `no_reply`: persist the turn but send nothing.
- Residual protocol tags are stripped before sending. `@name`/`@QQ` become at-segments, `[face name]` becomes QQ faces.
- `aigc.show_thinking` sends the tool/thinking trace as a separate forward message.

### 7.9 Scheduled injection

- `aigc_schedule` stores cron/one-shot tasks. Limits: 10 per user, 500 total, 1000 prompt characters.
- `schedule.init({ inject })` restores jobs at boot; triggers call `Bot.aigc.injectMessage({ self_id, user_id, group_id?, text, source })`.
- Injected turns pass through `evaluateTrigger` but skip user-side @/cooldown limits. User and injected requests queue rather than abort each other.

## 8. Design invariants

- The process must run from the repository root; relative paths are everywhere.
- There is no build step; edits under `lib/` need a restart, while top-level plugin files hot-reload.
- Constructors run multiple times; keep them purely declarative.
- Events are concurrent; do not assume serialization between listeners or turns.
- The browser is a singleton; never launch Chromium directly.
- SQLite uses one shared write connection; do not open competing long-lived writers.
- Config has two sources: tracked defaults and live copies. Never silently edit the live copy.
