---
name: skill-authoring
description: Create or update self-authored skills under data/skills; use when adding or fixing a skill.
allowed-tools: read write edit glob grep skill
---

# Skill authoring

Write self-authored skills to `data/skills/<name>/SKILL.md`. A skill with the same `name` overrides a built-in or plugin skill; plugin skill directories are read-only. A skill is instructions only — it cannot register tools.

Only `SKILL.md` is required. Optional directories: `scripts/`, `references/`, `assets/`.

## Frontmatter

Must be the first block, delimited by `---`.

| Field | Required | Rules |
|---|---|---|
| `name` | yes | lowercase letters, digits, `-`; must equal the directory name |
| `description` | yes | one line: what it does and when to use it; include trigger keywords |
| `tools` / `allowed-tools` | no | tool names, comma- or space-separated |

Malformed frontmatter falls back to the directory name and first body line, so always set `name` and `description`.

```md
---
name: my-skill
description: Extract data from X and summarize it. Use when the user asks about X.
allowed-tools: read write
---

# My skill

Steps to follow after activation.
```

## Body

- Write only what the agent would not already know: project conventions, exact commands and paths, non-obvious edge cases.
- Prefer short ordered steps and one working example over exhaustive prose.
- Reference resource files with relative paths and say when to load each; keep them one level deep.
- Add a gotchas section for mistakes the agent will make without being told.
- Include verification for fragile or destructive work; state what not to touch and when to ask.
- The full body loads on activation, so keep it under ~500 lines.
- Never store secrets, tokens, personal data, or large logs.

## Workflow

1. Pick an unused lowercase hyphenated name.
2. Write `data/skills/<name>/SKILL.md`.
3. Read it back, then load it with the `skill` tool.
4. The skill list is cached for 60 seconds, so a new skill may not appear immediately; editing an existing body takes effect at once.
5. After real use, fold corrections into the gotchas.

## Anti-patterns

- Vague descriptions such as "helps with tasks" — they never trigger.
- Restating general knowledge instead of project-specific procedure.
- Duplicating a built-in skill without adding value.
- Editing a plugin skill in place instead of overriding it in `data/skills/`.
- Declaring tools the caller cannot use.
- Keeping mutable state or generated output inside the skill directory.
