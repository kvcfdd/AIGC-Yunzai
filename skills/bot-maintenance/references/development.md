# Development reference

Read this before changing code or extending the bot. For how the system works, read `architecture.md`; for failures, read `troubleshooting.md`.

## 1. Environment and commands

```sh
pnpm i                                  # install dependencies
npx playwright install chromium         # required for rendering

node .                                  # foreground start
node . dev                              # foreground, dump render data to temp/ViewData
node . stop                             # stop through HTTP /exit
node . daemon                           # supervisor; exit code 255 stops it

pnpm start | stop | restart | log       # pm2 (config/pm2.yaml)
pnpm web                                # render-data viewer / lib/tools/web.js

node --check path/to/file.js            # syntax check only
npx prettier --write <changed files>
```

- Requires Node >= 24.16 and pnpm.
- Run from the repository root; relative paths are load-bearing.
- Do not run a repo-wide `pnpm lint` during diagnosis; it rewrites every JS file. Format only what you changed.
- Ports: bot HTTP/WS `2536`; renderer HTTP service `1134` (disabled by default); WebUI at `http://localhost:2536/yunzai`.

## 2. Code style

- ESM only, no build step. Use explicit relative imports; the source runs as-is.
- Prettier config: no semicolons, double quotes, `printWidth: 500`, `arrowParens: "avoid"`.
- Comments and commit messages are written in Chinese in this repository. Keep comments only where behavior is non-obvious.
- Make the smallest correct diff. Do not reformat or refactor unrelated code.
- Access config through `import cfg from "../lib/config/config.js"`; it is not a global.
- Do not add dependencies for a single feature unless necessary.

## 3. Adding a regular plugin

Place the file under `plugins/<dir>/`. If `plugins/<dir>/index.js` exists, only that file loads and it will not hot-reload. Otherwise every top-level `.js` file in the directory is loaded and watched with a 5-second debounce.

```js
export class Example extends plugin {
  constructor() {
    super({
      name: "example",
      dsc: "Example plugin",
      event: "message",
      priority: 5000,
      rule: [{ reg: /^#example$/, fnc: "example", permission: "master" }],
    })
  }

  async init() {
    // Runs once at load. Return "return" to skip registration.
  }

  async example() {
    return this.reply("ok", true)
  }
}
```

Rules:

- **Never do work in the constructor.** It runs twice at load and again for every matching event.
- `init()` runs on a temporary instance; do not rely on instance fields set there for later handlers. Use module-level state or re-read config.
- `rule.reg` is matched against `e.msg`; strings are compiled to `RegExp`. Anchor expressions deliberately.
- Rule/plugin `event` supports wildcards such as `notice.group.*`; the default plugin event is `message`.
- `priority` is ascending (default `5000`).
- Return `false` from a handler to continue matching later rules/plugins. Any other return value, including `undefined`, consumes the event.
- `permission` accepts `"master"`, `"owner"`, or `"admin"`; masters bypass it.
- Use `setContext` / `getContext` / `finish` for multi-step dialogs.
- Use `makeConfig(name, defaults)` (`lib/plugins/config.js`) for plugin config; it creates and merges `config/<name>.yaml`, not `config/config/<name>.yaml`.
- Files under `plugins/` are gitignored except `adapter/`, `system/`, `other/`, and `example/`. Confirm the target is actually tracked before relying on git.

## 4. Adding an AIGC tool

Create `lib/ai_core/tools/builtin/XTool.js`, register the tool, and add a side-effect import in `lib/ai_core/tools/index.js`.

```js
import tools from "../tool-registry.js"
import { isMaster, NON_MASTER_MSG } from "../workspace.js"

tools.register({
  name: "example_tool",
  description: "Do X. Use when the user asks for X.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query." },
    },
    required: ["query"],
  },
  execute: async (args, ctx) => {
    if (!isMaster(ctx)) return NON_MASTER_MSG
    if (!args.query?.trim()) throw new Error("query must not be empty")
    return { text: `result for ${args.query}` }
  },
})
```

Requirements:

- `parameters` must be a complete JSON Schema object: `{ type: "object", properties: {...}, required: [...] }`. A flat map of parameter specs is rejected by OpenAI with HTTP 400.
- Write tool and parameter descriptions in English. Put constraints in the schema (`enum`, `minimum`, `maxItems`, etc.), not only in prose.
- `execute(args, ctx)` receives: `event`, `user_id`, `signal`, `config`, `memory`, `llm` (the provider), `tools`, `schedule`, `skills`, `redis`, `logger`, `bot`, and `injectMessage`.
- Throwing becomes a tool error result. Do not return `undefined`; return a string or a structured result.
- Structured results: `{ text, images, image_paths, videos, video_paths, audios, audio_paths, files, file_paths }`. Other objects are JSON-stringified.
- Respect `ctx.signal` for long-running work and pass it to network calls.
- Master-only tools: add the name to `MASTER_ONLY_TOOLS` in `lib/ai_core/tools/workspace.js` and check `ctx.event.isMaster` in `execute`. Keep the tool listed for all users so the tool prefix stays stable.
- Use `resolveWorkspacePath` from `workspace.js` for file paths; it rejects paths outside the project root.

## 5. Adding a skill

- Built-in skill: `skills/<name>/SKILL.md` (tracked).
- User-authored skill: `data/skills/<name>/SKILL.md`; it overrides a built-in with the same `name`.
- Frontmatter: `name` (must equal the directory), `description` (one line, with trigger keywords), optional `tools` or `allowed-tools`.
- Progressive disclosure: startup loads only name + description; the body loads when the `skill` tool is called; supporting files load on demand. Keep the body under ~500 lines and put detail in `references/`.
- Reference files with relative paths from the skill root; keep references one level deep.
- The skill list is cached for 60 seconds. A new skill may not appear immediately; editing an existing body takes effect immediately.
- Do not shadow `bot-maintenance`, `bug-diagnosis`, `code-review`, or `skill-authoring` unless the operator asks.
- Optional skill dependencies belong in `skills/<name>/.deps/`, not in the project `package.json`.

## 6. Adding an MCP server

Add an entry under `aigc.mcp.servers` in config:

```yaml
mcp:
  servers:
    - name: local-tools
      type: stdio
      command: npx
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/allowed/dir"]
      cwd: ""
      timeout_ms: 30000
```

- Types: `http` (Streamable HTTP), `sse`, `stdio`.
- Tools are exposed as `mcp_<sanitized MCP tool name>`; server name is not part of the tool name. Duplicate names overwrite with a warning.
- MCP configuration is read at startup; a config change requires a restart.
- stdio stderr is forwarded to debug logs. A server with an empty tool list logs a warning.

## 7. Changing configuration

- Shipped defaults live in `config/default_config/*.yaml` and are tracked. Live values live in `config/config/*.yaml` and are gitignored.
- On startup, missing default files are copied into the live directory and missing keys are merged into existing live files, preserving comments.
- Live files are hot-reloaded with a 5-second debounce.
- `cfg.setConfig(name, key, value)` writes the live YAML and invalidates the cache; use it from plugins instead of editing files by hand.
- Group settings layer as `default` → `<bot_id>:default` → `<group_id>` → `<bot_id>:<group_id>`.
- Master mapping: `other.master` entries use `bot_id:user_id`.
- Some settings only take effect after a restart: `server.port`, HTTPS, `renderer.server.enable`, and MCP servers.

## 8. WebUI

- Served at `/yunzai`; legacy `/aigc_yunzai` redirects. Scope is config editing only.
- Core YAMLs are registered in `lib/webui/core-configs.js` (labels, descriptions, options, numeric limits).
- Plugin configs are auto-discovered from root `config/*.yaml` and `plugins/<dir>/config/*.yaml`.
- Login uses a one-time key requested with `#登录` in QQ: 10-minute single-use key, 12-hour HttpOnly cookie.
- Do not expose or weaken this authentication, and do not add endpoints outside config editing without an explicit request.

## 9. Verification

- Syntax check every edited file with `node --check <file>`.
- Re-read the affected call sites and config keys; check for compatibility with existing data and public behavior.
- For runtime behavior, rely on logs and the smallest reproducible input. Do not restart the live bot to "see if it works" unless the operator asks.
- Renderer changes can be checked with `node . dev` only in a separate, non-live environment; it dumps data to `temp/ViewData/`.
- Never claim a fix without actual output from a check, a log, or another observable verification.

## 10. Git and risky operations

- Commit messages are written in Chinese. Do not commit or push unless asked.
- `plugins/*` is gitignored except `adapter/`, `system/`, `other/`, and `example/`. miao-plugin and yuki-plugin are separate git repositories.
- `#更新` (`plugins/other/update.js`) runs `git pull` on the root and each plugin repo.
- `plugins/other/maint_task.js` can run `git reset --hard @{u}` on configured paths and clean configured directories; uncommitted work there can be destroyed.
- Never run `git reset --hard`, `git clean`, `rm -rf`, or force-push as part of maintenance.
- Never print, copy, or commit API keys from `config/config/*.yaml` or full logs containing user data.
