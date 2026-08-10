---
name: harness-init
description: Scaffolds a Git repository with validated repository-local PiBox harness policy. Use when asked to initialize, scaffold, prepare, or make a project ready for the harness.
---

# Harness Initialization

1. Confirm the current directory is the intended trusted Git repository.
2. Keep existing dirty work visible; initialization must fail rather than stash or commit unrelated files.
3. Call `harness_init` with:
   - `standard` for normal Sol/Terra/Luna role routing.
   - `economy` for lightweight experiments using Luna and reduced concurrency/repair budgets.
4. The capability writes `.pi/harness.yaml`, validates the effective merged configuration, and commits only that scaffold.
5. Do not overwrite an existing policy unless the user explicitly asks.
6. After initialization, inspect `harness_status` and continue naturally with ad-hoc work or managed planning.

Equivalent deterministic command:

```text
/harness init [standard|economy]
```
