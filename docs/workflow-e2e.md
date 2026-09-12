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
7. **Runtime-owned repair and correction** — Induce one deterministic or review failure and confirm repair uses a state slot rather than an authored task/evaluation. Confirm automatic repair limits come from `limits.repairRounds`. Introduce a wrong simulator destination, then correct the effective check through `request_changes` without rewriting the pinned task or replacing the story. Confirm the corrected check actually runs, completed contributions remain, retry counts never decrease, unchanged/no-op corrections are rejected, and fresh attempt tokens fence stale results. Repeat after repair exhaustion. Verify long repair instructions and findings survive input, persistence, and worker delivery intact; keep more than 32 ledger/correction entries and confirm only eight complete ledger entries enter initial implementer/fixer system context with ordinary access to the rest. Mutate the ledger between iterations and verify the same logical actors continue without refreshing that seed. Drive stage-review, whole-branch-review, and E2E through two fix cycles each; assert one verifier ID and one separate fixer ID per loop, actual continuation invocations, stable fixer cwd at newer canonical bases, and fresh E2E scratch paths. Verify reviewers/E2E get no ledger context or tool even under all-tools configuration. Submit a large Unicode ledger entry through the implementer tool, check its honest queued acknowledgement and parent persistence, and reject stale/failed/unauthorized submissions. Preserve dirty/invalid repair work rather than deleting it. Request a fix for a Critical review finding and confirm successful repair leads to independent re-review without waiving it. Check that the failure card is concise and its detail preserves the command, exit code, both output streams, and truncation notice.
8. **Whole-branch verification** — Confirm runtime-owned final review covers the exact execution-start-to-current diff and final E2E receives the complete story `e2e` field. Keep rich per-case JSON as retained evidence, separate from the terminal control reply described below. Fail E2E while writing a cited `evidence/result.json`, execute a real bounded repair, and retest into a distinct `evidence/rerun-result.json`. Confirm both reports remain byte-identical through repair/retest and ordinary completion commits both. At E2E repair, retest, and applicable resume boundaries, permit only exact revalidated prior evidence references; reject unrelated, uncited, ignored, missing, or unsafe files without deleting them or changing ignores. Other reviewers and repair kinds must retain their existing clean-tree checks.
9. **Persistence separation** — Confirm `state.yaml` alone drives scheduling/resume, `ledger.yaml` contains only curated non-obvious continuity, ordinary startup performs no repository or workflow disk reads, and `events.jsonl` is not read by first demand, prompts, status, metrics, or TUI.
10. **Reload** — During an active attempt, confirm `/reload` startup performs no disk restoration and the first explicit workflow demand automatically recreates a runner that may rebind only through the same process-global `SubagentService` activation without replaying files.
11. **Crash recovery** — Force owner loss. Confirm children terminate, the first explicit workflow demand in a later activation interrupts/fences old attempts and pauses before inspection, and only explicit resume plus any required bypass confirmation launches fresh attempts. No old process is adopted.
12. **Completion** — Confirm one `outcome.md` records delivery, checks, review/E2E, deviations, and residual risk, while the clean working branch remains ready for normal merge/PR handling.
13. **Event-driven timing** — Confirm all six repair actions count as Repair. At actual fixer spawn and continuation, read the already-committed active Repair clock; subsequent reviewer/E2E invocations must observe Review/E2E. Overlap implementation and repair in both activation and settlement orders: Repair takes priority while active, then timing immediately falls back to remaining work or closes. Check pause/attention with draining workers, capacity waits, spawn failure, stale settlement, stop, and owner loss without polling or duplicate accounting. Verify old global/stage totals gain only a zero Repair entry, category sums equal workflow time, and both terminal and Story Board display the authoritative live category.

14. **E2E card and matrix** — With current workflow phase `testing`, a previous repair result, and a retained rich report whose result is `blocked`, verify the final E2E card distinguishes current phase/repair count from recorded evidence. Show authored case identities/titles, case statuses, full actions/observations/evidence, and report findings in a readable matrix. Missing authored cases are `Not recorded`, not passed. Keep raw evidence links and explicit unavailable/fallback diagnostics for malformed reports. Exercise long content, untrusted strings/references, narrow screens, keyboard navigation, and live refresh without losing expanded details or focus. Other reviewer cards remain unchanged.

## E2E report file versus terminal result

Retained JSON under the story's `evidence/` directory may keep its rich `result`, `summary`, `caseResults` (with `caseId`, `status`, `executedActions`, `observations`, and `evidenceRefs`), and string `findings`. A report-file result such as `blocked` is evidence content, not a workflow control verdict. Previously cited reports are preserved; retests use distinct new filenames.

The evaluator's final assistant reply is a separate control JSON object. Its `result` must be `passed`, `repairable`, `critical`, `needs_user`, or `unsafe`. Use `passed` only when every required case passes, `repairable` for actionable product defects, and `needs_user` for prerequisites requiring user input. It includes a nonempty `summary` and top-level story-relative `evidenceRefs`. Optional `findings` are structured objects with unique nonempty `id`, `severity` (`critical`, `major`, or `minor`), nonempty `code` and `summary`, and optional `path`/positive integer `line`; do not add other finding fields.

For example, an unavailable testing prerequisite can retain a detailed blocked report while returning:

```json
{
  "result": "needs_user",
  "summary": "The required device prerequisite is unavailable; remaining cases were not exercised.",
  "findings": [],
  "evidenceRefs": ["evidence/result.json"]
}
```

Do not return the rich report file verbatim as the control reply. Neither a repaired contribution nor a recorded report substitutes for the next required E2E execution.

## Safety assertions

The exercise fails if the harness replays debug events, adopts a PID, tails a child file, relies on heartbeat recovery, claims graceful quit settlement, silently switches branches, discards dirty work, starts or resumes without required bypass confirmation, or authors evaluation/report/handoff resources.

Run deterministic repository checks after the exercise and keep generated benchmark output under ignored `.benchmark/`.
