---
name: harness-evaluate
description: Use when an approved task, integration unit, or work item has reached a declared verification boundary.
---

# Harness Evaluation

## Instructions

1. Use the planned boundary and criteria; avoid inventing a universal per-task pipeline.
2. Run deterministic checks where assembled behavior makes them meaningful.
3. Launch a fresh evaluator when independent judgment or runtime evidence is required.
4. Triage every finding as accepted, rejected, duplicate, deferred, resolved, or needing user authority.
5. Repair accepted findings within the configured budget and rerun affected proof.
6. Record evidence, verdict, tracked findings, and residual risk separately.
7. Call `work_item_complete` only after every required gate is satisfied.

## Completion

The deterministic completion capability is authoritative. Report its actual result and remaining non-blocking findings.
