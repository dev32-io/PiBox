# Workflow E2E Exercise: target contract

Use a disposable repository to exercise the complete managed workflow without creating authored evaluation, report, or handoff resources.

## Scenario

Shape a small local todo application, persist the story, stop for explicit story review, author a separate delivery plan, request execution, accept the extension-owned bypass confirmation, run the stages, and complete from runtime-owned whole-branch review and final E2E.

## Expected authored resources

```text
agent-artifacts/local-todo/
  story.yaml
  plan.yaml
  tasks/implement-local-todo.yaml
  state.yaml
  ledger.yaml
  events.jsonl
  outcome.md
```

`story.yaml` renders specification sections Outcome/Scope/Behavior/Acceptance, design sections Approach/Boundaries and Flow/Failure and Verification, and global E2E Scope plus stable `E2E-NNN` Exercise/Oracle/Proof cases. The task contains only metadata, `description`, `scope`, `delivery`, deterministic `checks`, and assignment. `plan.yaml` contains ordered sequential/concurrent stages with optional review mode/focus and no repair count. Story, E2E cases, tasks, and stages are authored through their flat specialized write tools; `workflow_compile` validates but does not execute.

The directory must not contain intent/spec/design sub-artifacts, brief/acceptance triplets, evaluation manifests, reports, attempt reports, checkpoints, handoffs, or duplicated outcome projections.

## Exercise boundaries

1. **Story review gate** — Confirm no story write occurs before the user validates the complete checkpoint. Confirm flat `story_write` plus per-case `e2e_write` render the required sections and a successful validation-only compile. After first persistence, confirm the session stops and does not load delivery planning until a later explicit request.
2. **Plan boundary** — Confirm every task is self-contained and contains no story/artifact/block references. Confirm flat `task_write`/`stage_write` drafts tolerate temporarily incomplete relationships and `workflow_compile` reports all remaining topology issues together. Confirm stages explicitly declare sequential or concurrent execution and planner-owned review policy has only mode/focus.
3. **Execution gate** — Confirm planning and acknowledgement do not start work. `workflow_start` validates prerequisites before showing bypass confirmation; cancellation launches nothing or changes no execution state.
4. **Persistent context** — Confirm the worker's stable system context contains complete description/scope/delivery and that checks remain a separate harness contract. Routine implementation should not call `task_clarify`.
5. **Clarification** — When a real uncertainty is introduced, confirm `task_clarify` can search and page bounded ranges of story `spec` or `design`, reports line/match/truncation metadata, and never exceeds its output cap.
6. **Stage progression** — Exercise one concurrent stage when independent tasks exist and one sequential stage only when a later task must consume integrated output. Confirm each stage crosses implementation/check, integration, stage-check, and optional review gates before the next starts.
7. **Runtime-owned repair** — Induce one deterministic or review failure and confirm repair uses a state slot rather than an authored task/evaluation. Confirm retry count comes from `limits.repairRounds`.
8. **Whole-branch verification** — Confirm runtime-owned final review covers the exact execution-start-to-current diff and final E2E receives the complete story `e2e` field.
9. **Persistence separation** — Confirm `state.yaml` alone drives scheduling/resume, `ledger.yaml` contains only curated non-obvious continuity, and `events.jsonl` is not read by startup, prompts, status, metrics, or TUI.
10. **Reload** — During an active attempt, `/reload` may rebind only through the same process-global `SubagentService` activation without replaying files.
11. **Crash recovery** — Force owner loss. Confirm children terminate, a later activation interrupts/fences old attempts and pauses, and only explicit resume plus any required bypass confirmation launches fresh attempts. No old process is adopted.
12. **Completion** — Confirm one `outcome.md` records delivery, checks, review/E2E, deviations, and residual risk, while the clean working branch remains ready for normal merge/PR handling.

## Safety assertions

The exercise fails if the harness replays debug events, adopts a PID, tails a child file, relies on heartbeat recovery, claims graceful quit settlement, silently switches branches, discards dirty work, starts or resumes without required bypass confirmation, or authors evaluation/report/handoff resources.

Run deterministic repository checks after the exercise and keep generated benchmark output under ignored `.benchmark/`.
