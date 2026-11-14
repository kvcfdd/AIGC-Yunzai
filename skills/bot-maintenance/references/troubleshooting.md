# Troubleshooting reference

Read this when something fails. Diagnose from evidence first; do not change code to guess.

Log lines and chat commands are quoted verbatim from the code, so they remain in their original language even though this document is in English.

## 0. Fast triage

| Symptom | Check first | Section |
| --- | --- | --- |
| Process exits or never comes online | Port, config YAML, plugin load, database | 2 |
| A config edit has no effect | Default vs live file, hot reload, restart-only keys | 3 |
| Commands do not trigger | Adapter connection, group gate, blacklist, rule match | 4 |
| AIGC does not reply | `aigc.enable`, private/group gates, model config | 5.1–5.3 |
| AIGC replies with a fixed error | Exact user-facing message, matching log line | 5.2–5.5 |
| Rendering fails | Chromium install, `browser.runTask`, backend config | 6 |
| Database errors or runaway disk use | Path, WAL, retention, media cache | 7 |

## 1. Safe diagnostics

- Read the tail of the relevant log:
  - PowerShell: `Get-Content logs/error.log -Tail 100`
  - POSIX: `tail -n 100 logs/error.log`
  - Daily command logs: `logs/command/YYYY-MM-DD.log`
- Logs may contain user data. Quote only the lines needed; never paste a full log or any key.
- Syntax-check an edited file with `node --check <file>`.
- Re-read the affected code path and config values before editing.
- Do not restart the bot to verify a theory unless the operator asks. If a restart is required, say so.
- Reproduce with the smallest input and capture the exact error string before changing code.

## 2. Startup failures

### Port already in use

The server logs `监听端口 <port> 错误` and then requests `/exit` from the same port, backing off and retrying. If another program owns the port, the retry loop continues.

- Windows: `Get-NetTCPConnection -LocalPort 2536 -State Listen | Select-Object OwningProcess`, then `Get-Process -Id <pid>`.
- POSIX: `ss -ltnp 'sport = :2536'` or `lsof -i :2536`.
- Do not kill the process unless the operator approves.

### Config YAML fails to parse

`lib/config/config.js` catches YAML errors at `trace` level (`读取配置文件 ... 错误`) and returns `undefined`, so defaults can silently apply while the live file is ignored.

- Validate the specific file with a YAML parser.
- Check indentation, tabs, duplicate keys, and unquoted values containing `:`.
- Never delete `config/config/` to "fix" it; that discards operator settings.

### Plugin load timeout or load error

- Timeout is `cfg.bot.plugin_load_timeout` seconds (default 60). The log says `插件加载超时 <file>`.
- Load failures log `插件加载错误 <file>` with the stack.
- `Cannot find package` produces a missing-dependency block: run `pnpm i`, or `pnpm add <pkg>` inside the plugin directory.
- A plugin that imports the network or does heavy work at module top level can block loading. Move work into `init()` or a handler.

### Chromium missing

Rendering starts Chromium lazily. The first render logs `[Browser] 启动失败` and advises `npx playwright install chromium`. Install it; do not switch renderers as a workaround.

### Database fails to load

`lib/config/redis.js` logs `数据库载入失败` and exits the process. Check `cfg.db.storage` / `data/db/data.db`, file permissions, free disk space, and corruption. Back up the file before any recovery attempt.

### Node is too old

`lib/config/init.js` falls back for `Promise.withResolvers` and warns `请更新 Node.js`. Upgrade Node to >= 24.16.

## 3. Configuration not taking effect

- Editing `config/default_config/` only changes defaults. Live values in `config/config/` win.
- Live files are hot-reloaded with a 5-second debounce. If the YAML is invalid, the cache invalidation can silently fall back to defaults; validate the file.
- Some values are read only at startup: `server.port`, HTTPS settings, `renderer.server.enable`, and `aigc.mcp.servers`. These require a restart.
- Group settings layer as `default` → `<bot_id>:default` → `<group_id>` → `<bot_id>:<group_id>`. Check the most specific override.
- AIGC model selection inherits global defaults: a use site's `model_config`/`adapter` overrides, otherwise `aigc.model_config`/`aigc.adapter`, otherwise the first model entry or `gemini`.
- Use `cfg.setConfig(name, key, value)` from plugins; direct file edits can race with the watcher.

## 4. Messages and plugins

### No messages arrive

- Check the adapter connection. OneBotv11 accepts a reverse WebSocket at `/OneBotv11`; the log shows `建立连接` / `断开连接`. GSUID requires `cfg.gsuid.enable` and an outbound connection to the core. `stdin` only exists in a TTY.
- `Bot.em` calls `prepareEvent` before emitting. If `self_id` is not in `Bot.bots`, enrichment is skipped, so the event arrives without `bot`, `friend`, `group`, `member`, or `reply` fields.

### Messages arrive but commands do not match

- Global lists: `other.blackUser`, `other.whiteUser`, `other.blackGroup`, `other.whiteGroup`.
- Group lists: `disable` excludes a plugin by `name`; `enable` restricts to the listed plugin names.
- Cooldowns: `groupCD`, `singleCD`, mute state, and a 1-second duplicate throttle keyed by `self_id:user_id:raw_message`.
- Group gate: `onlyReplyAt` and `botAlias` live in group config. If `onlyReplyAt` is `1` and `botAlias` is set, non-@ messages without the alias never reach rules. `onlyReplyAt: 0` or no `botAlias` admits everything.
- Rule problems: wrong `event` wildcard, regex anchored too tightly, or `e.msg` not containing what you expect (at-segments are excluded from `msg`).
- Priority: an earlier plugin consumed the event. A handler must return exactly `false` to let later rules run.
- Exceptions inside handlers are logged and consume the event; search `logs/error.log` around the timestamp.

### A plugin change does not apply

- Top-level `.js` files under a plugin directory hot-reload after a 5-second debounce.
- `plugins/<dir>/index.js` is imported alone and never hot-reloads.
- Anything under `lib/` requires a restart.
- Deleting a watched plugin file unloads it after the debounce.

### Duplicate or surprising side effects

- Constructors run once for `init()`, once for registration, and again for every matching event. Move I/O, timers, and network calls out of the constructor.
- `init()` runs on a temporary instance; instance fields set there are not preserved for handlers.

## 5. AIGC

### 5.1 No reply at all

Check in order:

1. `aigc.enable` — default `false`; `#开启aigc` writes the live value.
2. Private chat: `aigc.private_chat_enable`, and the sender must be in the bot's real friend list (`event.bot.fl`). Protocol-side public-account pushes are rejected.
3. Group whitelist: `aigc.group_whitelist` is restrictive when non-empty.
4. User blacklist: `aigc.qq_blacklist`.
5. Prefix filter: `aigc.prefix_filter` drops matching non-injected messages.
6. Bare `@bot`: needs `aigc.reply_on_bare_at: true`.
7. Ambient chat: `aigc.proactive_group_chat.probability` must be > 0; a 5-minute Redis key `aigc:ambient:cd:<group_id>` suppresses it after an @ or a previous ambient turn.
8. Group gate: if `onlyReplyAt`/`botAlias` blocks the message, the AIGC plugin never runs.
9. Scheduler: a running request may abort or merge; `#结束对话` aborts the current request and clears the session.

Useful logs: `发起对话`, `主动插话触发 (概率 N%)，进入 5 分钟冷却`, `合并请求`, `撞车，排队等待对方结束`, `用户 <id> 打断`.

### 5.2 Model configuration errors

The user-facing reply is `模型配置错误，请检查 aigc.models / model_config / adapter 配置`. The log names the specific code:

- `MODEL_CONFIG_NOT_FOUND` — `model_config` points to a missing `aigc.models[].name`; list the available names.
- `MODEL_REQUIRED` — the selected adapter needs `model`, and the entry has none.
- `UNSUPPORTED_ADAPTER` — `adapter` is not `gemini`, `openai`, `anthropic`, or `responses`.
- `INVALID_INCLUDE` — Responses `extra_body.include` must be an array.

Check that the entry has `base_url`, at least one `api_keys`, and the correct `model` field. Ambient chat uses `aigc.proactive_group_chat`; a bad entry there fails only ambient turns. `aigc.multimodal` and `aigc.embeddings` have their own selections.

### 5.3 Provider/API failures

- The log shows `全部失败`; the user gets `请求失败`.
- Check API keys and rotation, `base_url`, proxy settings, provider status, `retry_count`, and request timeouts.
- HTTP 400 can be a tool schema problem: a flat parameter map is rejected. Use a full JSON Schema object.
- Context-window errors can come from a too-small `context_window` or `max_output_tokens`; compaction thresholds are based on `context_window`.
- A safety block logs `安全拦截` and replies `内容被安全策略拦截`.

### 5.4 Media errors

The user gets `当前模型不支持该媒体类型，请关闭对应的 media 开关`.

- Check the model entry's `media.image/audio/video/file` flags.
- Anthropic does not support audio or video; OpenAI and Responses have base64 constraints for audio/files.
- Unsupported media can be converted to text through `aigc.multimodal` if configured.
- Very large files, download failures, GIF→MP4, silk→WAV, and office-document parsing all have their own limits under `lib/ai_core/media/`.

### 5.5 Tools, skills, and MCP

- `权限不足：用户未经授权，该工具仅 bot owner (master) 可执行` — the tool is master-only; use a master account or remove the restriction deliberately.
- `Unknown tool: <name>` — the tool is not registered; check the side-effect import in `lib/ai_core/tools/index.js`.
- `Tool <name> 未开启` — the tool's dynamic `enabled()` returned false.
- `工具轮次超限，降级回复成功` — the model kept calling tools past `max_tool_rounds`; raise the limit (2–150) or fix the tool loop.
- Skills: the list is cached for 60 seconds; malformed frontmatter falls back to the directory name and first body line. Supporting files need the master-only `read` tool.
- MCP: look for `连接失败: <server>, <error>`, `工具同步失败`, or `工具名冲突`. An empty tool list logs a warning. MCP config changes require a restart. Tool names are `mcp_<sanitized MCP tool name>`.

### 5.6 Memory and context

- `实际上下文追加失败，下一次请求回退到完整历史重新估算` — the live context append failed; the next turn re-seeds from the history table.
- Compaction runs at 20% of `context_window` for normal users and 65% for masters, keeping 3–10 recent turns.
- `#结束对话` clears one user's session; master-only `#结束全部对话` clears all sessions.
- Daily summaries require `aigc.memory.enable` and a working provider. The job runs at `00:00`; retention pruning runs at `04:17`.
- Semantic retrieval requires `aigc.embeddings.enable` and a model with matching `dimensions`.

### 5.7 Scheduled tasks

- Cron must be 5 fields (`minute hour day month weekday`); one-shot `at` uses local time `YYYY-MM-DD HH:mm[:ss]` and must be in the future.
- Limits: 10 tasks per user, 500 total, 1000 prompt characters.
- Injection goes through `evaluateTrigger`, so a disabled AIGC system rejects scheduled turns too.
- User and injected requests queue rather than abort each other; a busy scheduler delays execution.
- A one-shot task missed by up to 24 hours runs shortly after startup; older tasks are deleted. If the target bot is offline, the task is deferred by 10 minutes.

### 5.8 Output and voice

- `no_reply` persists the turn and sends nothing.
- `aigc.auto_split_max_chars` splits non-code replies shorter than the limit on blank lines; `0` (default) disables it.
- `<voice>` sends one voice message; the first non-empty voice block wins and text is ignored.
- Voice failures are TTS-template specific: check `aigc.voice.model_config`, the selected `aigc.voice.models` entry (`api` template, API key, voice ID) and `timeout_ms`.
- `aigc.show_thinking` sends the turn trace as a separate forward message; disable it if it clutters a group.

## 6. Rendering

- `[Browser] 禁止直连 Chromium，请在 browser.runTask() 回调内使用` — wrap all browser access in `browser.runTask(fn)`.
- `[Browser] 任务排队中（运行 N / 等待 M）` — concurrency is saturated; check `renderer.browser.concurrency` and whether tasks are leaking contexts.
- Idle shutdown is normal; the next task relaunches Chromium.
- The browser restarts after `restartNum` tasks. A restart during a task is serialized.
- The HTTP render service is disabled by default; enabling `renderer.server.enable` requires a restart. It listens on `127.0.0.1:1134` and serves `POST /render`.
- Fix template/data problems rather than raising concurrency.

## 7. Database and storage

- Default database: `data/db/data.db`; override with `cfg.db.storage`. WAL mode creates `-wal` and `-shm` files.
- The project uses one shared write connection; do not open a second long-lived writer from a tool or script.
- `SQLITE_BUSY` usually means an external process holds a lock; close it rather than deleting the database.
- Retention is controlled by `bot.context_retention_days` (default 30, `0` = unlimited). Pruning deletes old history and stats, not the database.
- Media caches under `data/aigc/chat`, `data/aigc/tmp`, and `data/aigc/tts` are safe to clean when the bot is idle; never delete `data/db/data.db` or `data/aigc/memory` without a backup.
- Disk-full conditions break downloads, media conversion, and SQLite writes; check free space before deeper debugging.

## 8. Stop and ask

Stop and ask the operator when a fix requires:

- Restarting or stopping the live bot.
- Deleting or restoring database, memory, or config data.
- Running git reset/clean, overwriting uncommitted work, or force-pushing.
- Changing authentication, opening a port, or exposing the WebUI.
- Handling a possible key or user-data leak.
- Choosing between behaviors that the code, docs, and logs cannot disambiguate.
