---
name: bug-diagnosis
description: Reproduce, isolate, and fix a bug, then verify the fix.
tools: read, grep, glob, pwsh, edit
master_only: true
---

# Bug diagnosis

1. Reproduce the bug with the smallest command or input; capture the exact error.
2. Locate the relevant code with `glob` and `grep`; read only the relevant sections with `read`.
3. State one or two plausible causes and the evidence for each.
4. Test each hypothesis with the narrowest command that can confirm or reject it.
5. Apply the smallest correct `edit`. Do not refactor unrelated code.
6. Re-run the reproduction and the relevant tests.
7. Report the cause, the change, and the verification output. Never claim a fix without a passing check.
