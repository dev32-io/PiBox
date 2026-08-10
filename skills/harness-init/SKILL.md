---
name: harness-init
description: Use when a trusted Git repository needs PiBox harness policy or repository-local worktree preparation.
---

# Harness Initialization

## Instructions

1. Confirm the intended trusted Git repository and require clean canonical state.
2. Call `harness_init` with `standard` for normal routing or `economy` for Luna-based low-cost runs.
3. Preserve existing policy unless overwrite was explicitly requested.
4. Verify `.pi/harness.yaml` and an effective root `/.worktree/` ignore rule.
5. Inspect harness status after the scaffold commit.

## Completion

Report the profile, changed paths, commit, and whether policy or ignore preparation already existed.
