---
name: harness-evaluate
description: Applies proportionate review, deterministic checks, regression, and E2E evidence at meaningful task, integration-unit, or final boundaries.
---

# Harness Evaluation

1. Follow the planned verification boundary; do not invent a universal per-task pipeline.
2. Invoke fresh spec, quality, combined, or E2E specialists with `agent_run` when independent judgment is worth its cost.
3. Run deterministic commands at the assembled boundary where they are meaningful.
4. Triage findings in the main session as accepted, rejected, duplicate, deferred, or needing user authority.
5. Repair only accepted findings and rerun only affected checks unless broader risk warrants more.
6. Record planned evaluation verdicts, reports, commands, and evidence with `evaluation_record`. Evidence paths must exist and are checksummed.
7. E2E is for meaningful user journeys, not isolated scaffolding. `blocked` requires a real attempted setup and exact blocker.
8. Finish with `work_item_complete`; never claim completion if its deterministic gate rejects the work item.
