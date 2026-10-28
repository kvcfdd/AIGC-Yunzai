# Development

Read `architecture.md` first for the repository layout. This file covers adding plugins, AIGC tools, skills, and config changes.

## Add a plugin

Place it in `plugins/<name>/`:

- `plugins/<name>/index.js` is imported once and **not hot-reloaded**.
- Other top-level `.js` files in that directory are watched and hot-reloaded (5s debounce).

Minimal plugin:

```js
export default class Example extends plugin {
  constructor() {
    super({
      name: "example",
      dsc: "Example plugin",
      event: "message",
      priority: 5000,
      rule: [{ reg: /^#example$/, fnc: "run" }],
    })
  }

  async run() {
    return this.reply("ok")
  }
}
```

Rules:

- `priority` is ascending; lower runs earlier. Default 5000.
- `rule.reg` may be a RegExp or a string compiled to RegExp.
- `rule.event` defaults to `message`; supports wildcards such as `notice.group.*`.
- `permission` can require master (`"master"`) or other existing loader permissions.
- Returning `false` from a handler keeps matching later rules/plugins; any other return value, including `undefined`, consumes the event.
- The current event is `this.e`; use `this.e.msg`, `this.e.isGroup`, `this.e.isMaster`, `this.e.img`, `this.e.atBot`, `this.reply()`, `this.e.runtime.render(...)`.
- Multi-step dialogs: `this.setContext("state")`, `this.getContext()`, `this.finish("state")`.

Plugin config:

```js
import { makeConfig } from "../../lib/plugins/config.js"

const cfg = makeConfig("my-plugin", { enable: true })
```

This creates/merges `config/my-plugin.yaml` under the tracked config directory.

Common mistakes:

- Doing work in the constructor. Classes are instantiated twice at load time plus once per matching event.
- Using `index.js` and expecting hot reload.
- Returning `undefined` when the intent was “continue matching”; return `false` explicitly.
- Assuming events are awaited. Listeners run concurrently.

## Add an AIGC tool

Create `lib/ai_core/tools/builtin/XTool.js`:

```js
import tools from "../tool-registry.js"

tools.register({
  name: "example_tool",
  description: "One sentence describing what the tool does and when to use it.",
  parameters: {
    type: "object",
    properties: {
      input: { type: "string", description: "Input value." },
    },
    required: ["input"],
  },
  execute: async (args, ctx) => {
    return `result: ${args.input}`
  },
})
```

Then add a side-effect import in `lib/ai_core/tools/index.js`.

Requirements:

- `parameters` must be a complete JSON Schema object with `type: "object"` and `properties`. A flat map of parameter specs will be sent to OpenAI as `type: null` and rejected with HTTP 400.
- Tool and parameter descriptions are written in English.
- Put constraints in the schema (`enum`, `required`, `minimum`, `maximum`, `minItems`, `maxItems`), not repeated prose.
- The executor receives `(args, ctx)`. `ctx` is created by `tools/tool-context.js` and exposes config, memory, provider, tools, skills, redis, logger, bot, event, signal, injectMessage.
- Return a string, or an object with `text`/`images`/`paths`/`videos`/`audios`/`files` fields; `tool-result.js` normalizes it.
- Throwing an error becomes a tool error result; keep messages actionable.
- If the tool is master-only, add its name to `MASTER_ONLY_TOOLS` in `lib/ai_core/tools/workspace.js` and check `ctx.event.isMaster` in `execute`.

Model-facing tool behavior:

- A stable tool catalog is better for prompt caching. Avoid registering/unregistering tools per request; use the existing master filter and readiness conditions.
- State when to use the tool, which alternative to use instead, and what failure/empty results mean.

## Add a skill

Built-in skill: `skills/<name>/SKILL.md`.
User skill: `data/skills/<name>/SKILL.md` (overrides a built-in with the same name).

Frontmatter:

```md
---
name: skill-name
description: One line describing when to use this skill.
tools: read, write, edit, pwsh
master_only: true
---
```

- Descriptions are shown in the system prompt; keep them under 100 characters.
- `master_only: true` hides the skill from non-master users and makes `skill` refuse it.
- The `skill` tool returns the body, the declared tools, and a file tree of the skill directory.
- Supporting files under the skill directory can be read with `read` (master-only skills only).
- Prefer a short SKILL.md plus `references/*.md` for depth; do not load everything at once.
- Optional dependencies for a skill belong in `skills/<name>/.deps/`, not the project `package.json`. Tell the model to install them on demand, for example `npm install --prefix skills/<name>/.deps <package>`.

## Change config

- `config/default_config/*.yaml` are tracked defaults.
- `config/config/*.yaml` are live, gitignored, and hot-reloaded.
- Change the default for shipped behavior; update the live copy only when the operator asks.
- Never print or commit API keys.
- Verify the key is read at the intended site: model configs are `aigc.models[]`; `name` selects a config and `api` selects the adapter type.

## Verify

```sh
npx prettier --write <changed files>
git diff
git status
```

- Do not run repo-wide `pnpm lint` during diagnosis; it rewrites every JS file.
- Code under `lib/` is not hot-reloaded. Tell the operator a restart is required; do not stop/restart the running process yourself.
