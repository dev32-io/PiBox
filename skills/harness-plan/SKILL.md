---
name: harness-plan
description: Converts clarified intent into canonical specs, design, tasks, integration units, and proportionate verification, then submits the deliverable contract for direct user approval.
---

# Harness Planning

1. Create or select a managed work item.
2. Use `artifact_create` and `artifact_update` for canonical specs, designs, and decisions. Do not edit `agent-artifacts/` directly.
3. Define bounded contribution tasks with `task_define`.
4. Group partial tasks into the smallest meaningful integration units. A task need not build or be independently reviewable before assembly.
5. Put review, tests, and E2E at the cheapest meaningful boundary. Explicitly skip, defer, batch, or combine ceremony when appropriate.
6. Map binding acceptance to credible final proof without forcing one evaluator per criterion.
7. Use `evaluation_define` only for checks the plan actually requires.
8. Run a fresh plan critic for risky work and triage its findings yourself.
9. Call `planning_submit` when the deliverable contract is coherent. Tell the user to approve with `/harness approve <id>`; never self-approve.
