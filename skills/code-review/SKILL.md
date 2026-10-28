---
name: code-review
description: Review a change for correctness, security, tests, and regressions.
tools: read, grep, glob, pwsh
master_only: true
---

# Code review

1. Get the diff or changed files (`git diff`, `git status` via `pwsh`).
2. Read the surrounding code, not only the changed lines.
3. Check in this order:
   - Correctness: edge cases, error handling, cleanup, concurrency.
   - Security: untrusted input, path traversal, command injection, secret exposure.
   - Tests: new or updated tests, and whether they fail without the fix.
   - Compatibility: public API, config keys, stored data, migrations.
4. Report concrete findings only: file:line, failure scenario, suggested fix.
5. Separate must-fix issues from nits. If the change looks correct, say so; do not invent issues.
