---
name: skill-authoring
description: Create or update Agent Skills under data/skills; use when adding or fixing a skill.
allowed-tools: read write edit glob grep
master_only: true
---

# Skill authoring

Use this skill to create or update a self-authored Agent Skill. The open standard is at https://agentskills.io/specification. Skills are instructions loaded on demand; they are not plugins and cannot add tools.

## Where skills live in this bot

- Self-authored skill: `data/skills/<name>/SKILL.md` — write here.
- Built-in skill: `skills/<name>/SKILL.md` — reference only; a user skill overrides a built-in with the same `name`.
- Never shadow `bot-maintenance`, `bug-diagnosis`, `code-review`, or `skill-authoring` unless the operator asks.

Standard directory layout (only `SKILL.md` is required):

```
<name>/
├── SKILL.md          # metadata + instructions
├── scripts/          # optional executable code
├── references/       # optional documentation loaded on demand
└── assets/           # optional templates and resources
```

## Frontmatter

Must be the first content in the file, delimited by `---`. Standard fields:

| Field | Required | Rules |
|---|---|---|
| `name` | yes | 1-64 chars; lowercase `a-z`, digits, `-`; no leading/trailing `-`; no `--`; must equal the directory name |
| `description` | yes | 1-1024 chars; say what the skill does and when to use it, with trigger keywords |
| `license` | no | license name or reference to a bundled license file |
| `compatibility` | no | 1-500 chars; environment requirements |
| `metadata` | no | string-to-string map for extra fields |
| `allowed-tools` | no | space-separated tools the skill expects (experimental in the standard) |

This bot's parser additions and limits:

- Accepts `tools` as an alias of `allowed-tools` (comma- or space-separated).
- `master_only: true` hides the skill from non-master users and makes `skill` refuse it; use it for anything touching files or commands.
- The system-prompt skill list shows only `description`, clipped to 100 characters — keep `description` under 100 characters here even though the standard allows 1024.
- `license`, `compatibility`, and `metadata` are accepted but not surfaced by this bot.
- Malformed YAML falls back silently to the directory name and the first body line; always set `name` and `description` explicitly.

Minimal example:

```md
---
name: my-skill
description: Extract data from X and summarize it. Use when the user asks about X.
allowed-tools: read write
master_only: true
---

# My skill

Steps the agent follows after activation.
```

## Progressive disclosure

1. Startup: only `name` + `description` load for every skill.
2. Activation: the full `SKILL.md` body loads. Keep it under 500 lines / ~5,000 tokens; this bot hard-caps the body at 16 KB and truncates the rest.
3. Resources: `scripts/`, `references/`, and `assets/` load only when needed. Tell the reader exactly when to load each file, for example: "Read `references/api-errors.md` when a request returns non-200."

Reference files with relative paths from the skill root and keep references one level deep.

## Writing the body

- Add what the agent would not know: project conventions, exact commands/paths, non-obvious edge cases.
- Prefer short, ordered procedures and one working example over exhaustive prose.
- Give a default instead of a menu of equal options; mention alternatives as escape hatches.
- Include a "Gotchas" section for mistakes the agent will make without being told.
- Include a verification step for fragile or destructive work.
- State what not to touch and when to stop and ask the operator.
- Never store secrets, tokens, personal data, or large logs.

## Workflow

1. Read the current skill list from the system prompt; inspect an existing skill with the `skill` tool.
2. Pick a lowercase hyphenated name equal to the directory name; confirm it is unused under `skills/` and `data/skills/` with `glob`.
3. Write `data/skills/<name>/SKILL.md` with `write`.
4. Validate:
   - Standard check, if available: `skills-ref validate data/skills/<name>`.
   - Bot check: read the file back, then load it with the `skill` tool.
5. The skill list is cached for 60 seconds: a new skill may not appear through `skill` immediately; wait for the cache or read the file directly. Editing an existing body takes effect immediately.
6. After real use, add corrections to the gotchas section.

## Anti-patterns

- Duplicating a built-in skill without adding value.
- Vague descriptions such as "helps with tasks" — they never trigger.
- Declaring tools the current user cannot use.
- A body that restates general knowledge instead of project-specific procedure.
- Keeping mutable state or generated output inside the skill directory; use project data paths instead.
