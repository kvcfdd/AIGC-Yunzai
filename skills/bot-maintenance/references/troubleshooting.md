# Troubleshooting

## First five minutes

1. Identify the symptom: wrong reply, no reply, exception log, process exit, slow reply, tool failure.
2. Check logs:
   - `logs/error.log`
   - `logs/command.*.log` (older files may be `.zst` compressed)
   - `logs/` for other recent files
3. Search the source with `grep`; read only the relevant files.
4. Check whether the process is running and which port is listening:
   - Bot HTTP/WS: `2536`
   - Renderer HTTP service: `1134` (if enabled)
5. Reproduce with the smallest command or message.

## Common error patterns

### `400 Invalid schema for function 'X': schema must be a JSON Schema of 'type: "object"', got 'type: null'`

The tool's `parameters` are not a complete JSON Schema. Fix:

```js
parameters: {
  type: "object",
  properties: { ... },
  required: [...],
}
```

A flat map of parameter specs is not accepted by this repository's registry.

### `404 status code (no body)` or HTTP 404 from an LLM API

Usually a base URL or route mismatch, not a model-name problem.

- OpenAI-compatible: `base_url` should end at `/v1`; the SDK appends `/chat/completions`.
- Anthropic-compatible: the SDK appends `/v1/messages`. For DeepSeek's Anthropic endpoint the base URL is `https://api.deepseek.com/anthropic`; using `https://api.deepseek.com` hits the OpenAI route and returns 404.
- Responses API: `base_url` ends at `/v1`.
- If the gateway requires a different path, set the base URL to the segment before `/v1/messages` and check with a direct request.
- The model name is sent as-is; a 404 with no body usually means the HTTP route does not exist.

### 401 / 403

Check `api_keys`, account permissions, and whether the selected model/config matches the endpoint. Keys rotate per channel; one bad key can fail a request.

### 429

Rate limit. The adapters rotate keys and retry after a delay. Check `retry_count`, key pool size, and provider limits.

### TIMEOUT / `请求超时`

- Check `timeout_ms` on the selected model config.
- The Gemini Interactions SDK disables its own per-attempt timeout when a request signal is present; the adapter supplies its own `AbortSignal.timeout`.
- Provider retries and backoff can make total wait much longer than `timeout_ms`; distinguish per-attempt timeout from total time.
- For long `web_fetch`/shell operations, check the browser or command timeout.

### `MODEL_CONFIG_NOT_FOUND` / `UNSUPPORTED_API`

- `model_config` must match a `name` in `aigc.models[]`.
- `api` must be one of `gemini`, `openai`, `anthropic`, `responses`.
- Unset values inherit the global default; check the usage site (main vs `proactive_group_chat`).

### MCP tools missing

- Check `aigc.mcp.servers` and the server's `type`/`url`/`command`/`args`.
- Check connection logs for timeout or authentication errors.
- A failed/disconnected server removes its `mcp_<name>` tools.

### Plugin does not load or does not reload

- Plugin must be in a direct subdirectory of `plugins/`.
- If `index.js` exists, only that file loads and it is not hot-reloaded.
- Check the class extends the global `plugin` and calls `super({...})`.
- Check `rule.event` and `rule.reg`; check whether an earlier handler consumed the event.
- `return false` continues matching; any other return consumes.

### Renderer fails

- Chromium must be installed: `npx playwright install chromium`.
- All rendering goes through `browser.runTask(fn)`; callers must close their contexts.
- Check `renderer.browser.concurrency`, `restartNum`, and `idleTime`.
- If the renderer HTTP service is enabled, check port `1134`.

### SQLite busy/locked

- The process uses shared better-sqlite3 connections with WAL and `busy_timeout`.
- Avoid opening a write transaction and awaiting unrelated async work inside it.
- Check for an external process holding `data/db/data.db`.

## Restart and verification

- Config under `config/config/*.yaml` is hot-reloaded.
- Code under `lib/` and plugins using `index.js` require a restart.
- Do not run `node . stop` or restart the bot yourself unless the operator explicitly asks; you may kill the process producing the reply.
- After a restart, verify the original symptom and check `logs/error.log` again.

## Safe operations

- Never run `git reset --hard`, `git clean`, `rm -rf`, or force-push unless the operator explicitly asks.
- `plugins/other/maint_task.js` can reset configured plugin repos with `git reset --hard @{u}`; uncommitted work there can be destroyed.
- Do not print `config/config/*.yaml` API keys or paste full logs that may contain user data.
- Revert only your own change when verification fails; do not discard unrelated work.
- State clearly what was changed, what was verified, and what still requires a restart.
