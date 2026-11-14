# AGENTS.md

## Overview

AIGC-Yunzai is a QQ bot (Node.js ESM, no build step) with an integrated AIGC subsystem (LLM chat, tools, memory, knowledge base, TTS). Requirements: Node.js >= 24.16, pnpm, FFmpeg. Run commands from the repository root; plugin/listener discovery and runtime data paths are cwd-relative.

Key directories: `app.js` (entry), `lib/` (core), `plugins/` (plugins and adapters), `renderers/` (screenshot backends), `config/` (defaults + live copies), `data/` (runtime state), `skills/` (built-in skills), `test/` (local-only tests, gitignored).

## Commands

```sh
pnpm i                          # install dependencies
npx playwright install chromium # required for rendering

node .                          # foreground
node . dev                      # foreground, dump render data to temp/ViewData
node . stop                     # stop via HTTP /exit
node . daemon                   # supervisor, restarts child on exit code 255
pnpm start|stop|restart|log     # pm2 (config/pm2.yaml)
pnpm web                        # render-data viewer on http://localhost:8000

npx prettier --write <changed files>
node --test --test-force-exit test/ai_core/<file>.test.js
```

Ports: bot HTTP/WS `2536`; WebUI `http://localhost:2536/yunzai`; renderer HTTP `1134` (disabled by default); `pnpm web` debug viewer `8000`.

## Boot

`app.js` parses `stop|daemon|pm2|start` (default internal) and runs `lib/bot.js` `Bot.run()`:

1. config + logger init (`lib/config/init.js`)
2. `lib/ai_core` init, including MCP servers and scheduled tasks
3. HTTP/WS server on `cfg.server.port` (2536), WebUI mount, optional HTTPS
4. `PluginsLoader.load()` (`lib/plugins/loader.js`)
5. `ListenerLoader.load()` (scans `lib/events/*.js`, then adapters)
6. `emit("online")`

`Bot` is a Proxy over `Bot.bots`; unknown properties fall through to `lib/util.js` helpers or a random logged-in account. Each account is `Bot[self_id]` with `pickFriend` / `pickGroup` / `sendApi`. Globals: `Bot`, `plugin`, `segment`, `logger`, `redis`.

Adapters self-register in `plugins/adapter/*.js`: `OneBotv11` (reverse WS `/OneBotv11`), `GSUIDClient` (outbound WS to 早柚核心, only when `cfg.gsuid.enable`), `stdin` (TTY or `FORCE_TTY`).

Events use `<post_type>.<message_type>.<sub_type>`; `Bot.em()` also emits every parent prefix, so `event: "message"` catches all message subtypes. Listeners are not awaited.

## Plugins

- Only direct subdirectories of `plugins/` are discovered. If `plugins/<dir>/index.js` exists, only it is imported and it has no hot reload; otherwise every top-level `.js` file is a plugin and watched by chokidar (5s debounce; new files are also picked up).
- A plugin extends the global `plugin`; pass `{ name, dsc, event, priority, rule, task, handler, namespace }` to `super()`. `priority` is ascending (default 5000); lower runs first.
- `init()` runs once; returning `"return"` skips loading. Do not do work in the constructor: classes are instantiated twice at load and once per matching event.
- Handlers return `false` to keep matching later rules/plugins; any other value (including `undefined`) consumes the event.
- `rule.event` supports wildcards (`notice.group.*`); `rule.permission` can be `"master"`, `"owner"`, `"admin"`.
- `setContext` / `getContext` / `finish` / `awaitContext` implement multi-step dialogs. `makeConfig(name, defaults)` creates/merges `config/<name>.yaml`.
- `e` exposes `msg`, `img`, `video`, `audio`, `at`, `atBot`, `file`, `isGroup`, `isPrivate`, `isMaster`, `reply_id`, `runtime`, and a wrapped `reply()`.

## Config and data

- `config/default_config/*.yaml` are tracked defaults; `config/config/*.yaml` are live, gitignored, hot-reloaded copies.
- `cfg.<name>` merges live over default at the top level only (nested objects are replaced, not deep-merged). Access via `import cfg from "../lib/config/config.js"` (not a global). `cfg.master` / `cfg.masterQQ` hold master accounts; `cfg.setConfig(name, key, value)` writes the live copy.
- Config file changes invalidate the cached config after a 5s debounce (`lib/config/config.js`).
- `data/` is gitignored runtime state: SQLite `data/db/data.db`, AIGC media/memory under `data/aigc/*`, user skills under `data/skills/`.
- `global.redis` is a node-redis-v4-compatible client backed by SQLite tables (`lib/redis/`); there is no Redis server.
- `lib/db.js` + `lib/sqlite-conn.cjs` provide shared better-sqlite3 connections (WAL, busy_timeout); `lib/modules/` holds pnpm-linked legacy shims (lodash, sqlite3, node-fetch, oicq).

## Rendering

- Playwright Chromium is a process-wide singleton in `lib/renderer/browser.js`. All access goes through `browser.runTask(fn)`; `getBrowser()` throws outside that context. Callers close their own browser contexts.
- `browser` enforces `renderer.browser.concurrency`, restarts after `restartNum` tasks, and closes after `idleTime` idle minutes.
- Backends are plugins in `renderers/<id>/index.js`: `playwright` (default screenshot backend) and `server` (`POST /render` on `127.0.0.1:1134`, disabled by default).
- `e.runtime.render(...)` goes through `lib/puppeteer/puppeteer.js` and returns `segment.image`. `node . dev` dumps render data to `temp/ViewData/`.

## AIGC subsystem (`lib/ai_core/`)

`Bot.aigc` exposes `provider`, `memory` (alias `conversation`), `tools`, `mcp`, `skills`, `knowledge`, `voice`, `requestScheduler` (alias `coordinator`), `dialogue`, `schedule`, `config`, `AigcError`, `injectMessage`. The user-facing entry is `plugins/system/aigc.js` — priority `999999999` (runs last) with a catch-all rule plus `#开启aigc` / `#关闭aigc` / `#结束对话` / `#结束全部对话`.

| Layer | Responsibility |
|---|---|
| `perception/` | Trigger gating, event -> turns, system prompt, injected events, message formatting, media resolution |
| `llm/` | Provider facade and adapters (`gemini`, `openai`, `anthropic`, `responses`), API-key rotation, retry, model config resolution, proxy dispatch |
| `core/` | `dialogue.js` single-turn orchestration, `tool-loop.js` tool loop (`max_tool_rounds`), `request-scheduler.js` merge/queue/abort, `tool-compaction.js` context budgets |
| `tools/` | Tool registry and 18 built-ins (`tools/builtin/`), MCP (`tools/mcp/`), skills (`tools/skills/`), workspace guards |
| `memory/` | Append-only `aigc_message` history, live `aigc_context`, daily summaries (`aigc_memory_day` + FTS5 + optional sqlite-vec), persistent files under `data/aigc/memory/`, retention and context compression |
| `embeddings/` | Embedding adapters (`gemini`, `openai`) driven by `aigc.embeddings` |
| `knowledge/` | Document import, chunking, hybrid dense+sparse retrieval, optional `/rerank` |
| `output/` | Reply protocol (`<xix>` split, `<voice>` single reply, `no_reply`), reply sender, TTS registry under `output/tts/`, turn tracing |
| `media/` | Download/cache, size limits, image downscale, GIF->MP4, silk->WAV, office docs->text |
| `schedule/` | SQLite-backed cron/one-shot tasks that inject prompts into the dialogue flow |
| `helpers/` | QQ face map, HTTP/SSRF-safe fetch, file tree, time formatting |

Model configs live in `aigc.models[]`; `name` selects the entry and `aigc.adapter` selects the adapter type (it is not stored per entry). Usage sites (`model_config` / `adapter`) override the global default. Request channels are `main` and `ambient` (token usage and API-key rotation are per channel).

Triggering: `cfg.aigc.enable` (default false), per-user/group whitelists/blacklists, @bot in groups, ambient chat (`aigc.proactive_group_chat.keywords` match or `.probability`; only when the group has no in-flight request and at least 10s after the last one ended), private chat (`aigc.private_chat_enable` + real-friend check), prefix filters. External code injects a synthetic turn via `Bot.aigc.injectMessage({ self_id, user_id, group_id?, text, source? })`; scheduled tasks use the same path.

Context compression: incremental token counting; thresholds are 20% of the context window for normal users and 65% for the master; compaction keeps 1/10 of turns (min 3, max 10), with a summary model call.

### Adding an AIGC tool

Create `lib/ai_core/tools/builtin/XTool.js`, call `tools.register({ name, description, parameters, execute })`, and add a side-effect import in `lib/ai_core/tools/index.js`.

- `parameters` must be a complete JSON Schema: `{ type: "object", properties: {...}, required: [...] }`. A flat map is rejected by OpenAI with HTTP 400 (`type: null`).
- Tool/parameter descriptions in English; put constraints in the schema (`enum`, `minimum`, `maxItems`, ...).
- `execute(args, ctx)` — `ctx` exposes `event`, `signal`, `config`, `memory`, `llm`, `tools`, `schedule`, `skills`, `redis`, `logger`, `bot`, `injectMessage`. Throwing becomes a tool error result.
- Master-only tools: add the name to `MASTER_ONLY_TOOLS` in `lib/ai_core/tools/workspace.js`; they stay listed for all users to keep the tool prefix stable.

### Skills

Built-in: `skills/<name>/SKILL.md` (currently only `skill-authoring`). User skills: `data/skills/<name>/SKILL.md` override by name. Frontmatter: `name`, `description`, `tools` (alias of `allowed-tools`). The `skill` tool returns the body, declared tools, and a directory file tree; supporting files are read with the master-only `read` tool. Optional deps go in `skills/<name>/.deps/`.

### Voice and faces

`aigc.voice.model_config` selects an entry in `aigc.voice.models[]`; each entry's `api` selects the TTS template: `wusound`, `openai`, `deepseek`, `gemini`, `minimax`, `elevenlabs`, `azure`, `volcengine`, `mimo`, `fishaudio`, `dashscope`. TTS failure falls back to text.

QQ face maps are static in `lib/ai_core/helpers/face.js`: `FACE_MAP` is qSid -> name, `FACE_LOOKUP` is name/alias -> qSid. Only numeric qSid (sendable `face` segments) are included; emoji expressions stay Unicode text. Source: SnowLuma `sys-face-catalog.json`; duplicate IDs/names prefer 小黄脸 > QQ黄脸 > 汪汪 > 企鹅 > 其它 > 超级表情.

### MCP

`lib/ai_core/tools/mcp/manager.js` uses `@modelcontextprotocol/client` v2 with Streamable HTTP, SSE, and stdio transports. Servers are configured under `aigc.mcp.servers` and exposed as `mcp_<name>` tools; a disconnected server removes its tools. `protocol_mode` supports `legacy` (default) and `auto`.

## WebUI

`lib/webui/` serves a vanilla SPA at `/yunzai` (legacy `/aigc_yunzai` redirects). Features: config editing (form + raw YAML), dashboard (messages, tokens, CPU/memory), knowledge-base management, and Miao help theme management. Core configs are registered in `lib/webui/core-configs.js`; plugin configs and plugin data configs are auto-discovered.

All `/api` routes require a session. `#登录` (master only, `plugins/system/webui-login.js`) creates a 10-minute single-use key and sends it privately; login exchanges it for a 12-hour HttpOnly `SameSite=Strict` session cookie. Do not weaken this flow.
