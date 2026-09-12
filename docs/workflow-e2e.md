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

Do not author intent/spec/design sub-artifacts, brief/acceptance triplets, evaluation manifests, reports, checkpoints, handoffs, or duplicated outcome projections. The harness retains submitted E2E reports and supporting files under the story's `evidence/` directory.

## Exercise boundaries

1. **Story review gate** — Confirm no story write occurs before the user validates the complete checkpoint. Confirm flat `story_write` plus per-case `e2e_write` render the required sections and a successful validation-only compile. After first persistence, confirm the session stops and does not load delivery planning until a later explicit request.
2. **Plan boundary** — Confirm every task is self-contained and contains no story/artifact/block references. Confirm flat `task_write`/`stage_write` drafts tolerate temporarily incomplete relationships and `workflow_compile` reports all remaining topology issues together. Confirm stages explicitly declare sequential or concurrent execution and planner-owned review policy has only mode/focus.
3. **Execution gate** — Confirm planning and acknowledgement do not start work. `workflow_start` validates prerequisites before showing bypass confirmation; cancellation launches nothing or changes no execution state.
4. **Persistent context** — Confirm the worker's stable system context contains complete description/scope/delivery and that checks remain a separate harness contract. Routine implementation should not call `task_clarify`.
5. **Clarification** — When a real uncertainty is introduced, confirm `task_clarify` can search and page bounded ranges of story `spec` or `design`, reports line/match/truncation metadata, and never exceeds its output cap.
6. **Stage progression** — Exercise one concurrent stage when independent tasks exist and one sequential stage only when a later task must consume integrated output. Confirm each stage crosses implementation/check, integration, stage-check, and optional review gates before the next starts.
7. **Runtime-owned repair and correction** — Induce one deterministic or review failure and confirm repair uses a state slot rather than an authored task/evaluation. Confirm automatic repair limits come from `limits.repairRounds`. Introduce a wrong simulator destination, then correct the effective check through `request_changes` without rewriting the pinned task or replacing the story. Confirm the corrected check actually runs, completed contributions remain, retry counts never decrease, unchanged/no-op corrections are rejected, and fresh attempt tokens fence stale results. Repeat after repair exhaustion. Verify long repair instructions and findings survive input, persistence, and worker delivery intact; keep more than 32 ledger/correction entries and confirm only eight complete ledger entries enter initial implementer/fixer system context with ordinary access to the rest. Mutate the ledger between iterations and verify the same logical actors continue without refreshing that seed. Drive stage-review, whole-branch-review, and E2E through two fix cycles each; assert one verifier ID and one separate fixer ID per loop, actual continuation invocations, stable fixer cwd at newer canonical bases, and fresh E2E scratch paths. Verify reviewers/E2E get no ledger context or tool even under all-tools configuration. Submit a large Unicode ledger entry through the implementer tool, check its honest queued acknowledgement and parent persistence, and reject stale/failed/unauthorized submissions. Preserve dirty/invalid repair work rather than deleting it. Request a fix for a Critical review finding and confirm successful repair leads to independent re-review without waiving it. Check that the failure card is concise and its detail preserves the command, exit code, both output streams, and truncation notice.
8. **Whole-branch verification** — Confirm runtime-owned final review covers the exact execution-start-to-current diff and final E2E receives the complete story `e2e` field. Use the real `workflow_e2e_report` tool for a failing report, fix the product, then submit the retest report. Confirm the harness chooses canonical report paths, retains evidence supplied at case level before scratch cleanup, and commits complete unchanged reports at completion. Invalid tool arguments should be corrected in the same evaluator attempt without a repair round. Final prose must not control the verdict. At repair/retest boundaries retain exact owned evidence and reject unrelated or unsafe files without deletion, ignore changes, or directory-wide allowances.
9. **Persistence separation** — Confirm `state.yaml` alone drives scheduling/resume, `ledger.yaml` contains only curated non-obvious continuity, ordinary startup performs no repository or workflow disk reads, and `events.jsonl` is not read by first demand, prompts, status, metrics, or TUI.
10. **Reload** — During an active attempt, confirm `/reload` startup performs no disk restoration and the first explicit workflow demand automatically recreates a runner that may rebind only through the same process-global `SubagentService` activation without replaying files.
11. **Crash recovery** — Force owner loss. Confirm children terminate, the first explicit workflow demand in a later activation interrupts/fences old attempts and pauses before inspection, and only explicit resume plus any required bypass confirmation launches fresh attempts. No old process is adopted.
12. **Completion** — Confirm one `outcome.md` records delivery, checks, review/E2E, deviations, and residual risk, while the clean working branch remains ready for normal merge/PR handling.
13. **Event-driven timing** — Confirm all six repair actions count as Repair. At actual fixer spawn and continuation, read the already-committed active Repair clock; subsequent reviewer/E2E invocations must observe Review/E2E. Overlap implementation and repair in both activation and settlement orders: Repair takes priority while active, then timing immediately falls back to remaining work or closes. Check pause/attention with draining workers, capacity waits, spawn failure, stale settlement, stop, and owner loss without polling or duplicate accounting. Verify old global/stage totals gain only a zero Repair entry, category sums equal workflow time, and both terminal and Story Board display the authoritative live category.

14. **E2E card and matrix** — With current workflow phase `testing`, a previous repair result, and a retained rich report whose result is `blocked`, verify the final E2E card distinguishes current phase/repair count from recorded evidence. Show authored case identities/titles, case statuses, full actions/observations/evidence, and report findings in a readable matrix. Missing authored cases are `Not recorded`, not passed. Keep raw evidence links and explicit unavailable diagnostics; an unavailable exact current report must not fall back to an older passing report. Older pointerless records remain readable. Exercise long content, untrusted strings/references, narrow screens, keyboard navigation, and live refresh without losing expanded details or focus. Other reviewer cards remain unchanged.

## One harness-owned E2E report

Managed E2E uses `workflow_e2e_report`, not Bash-written report JSON or a second terminal control reply. One submission supplies the complete case set:

```json
{
  "cases": [{
    "case": "E2E-001",
    "verdict": "failed",
    "steps": ["Open settings", "Fill valid schedule fields", "Press Save"],
    "expected": "A saved schedule appears.",
    "observed": "The editor remains open and no save request is sent.",
    "evidence": ["/tmp/e2e-scratch/save-network.txt"]
  }]
}
```

Case verdicts are `passed`, `failed`, or `blocked`. Steps, expected/observed results, evidence files and notes preserve full content without arbitrary length/count caps. Summary and findings are optional; findings contain a summary and optional `minor`, `major`, or `critical` severity, without model-invented IDs or codes. Every required case must be accounted for; unavailable cases can be blocked rather than falsely passed. Incorrect arguments return a tool error that the evaluator can correct within the same attempt. A later successful complete submission replaces only that attempt's pending submission, not earlier accepted reports.

The tool serializes JSON and stages supplied evidence. Its acknowledgment distinguishes queued submission from parent acceptance. After the owned evaluator settles, the harness retains the report and attachments in the canonical repository under `agent-artifacts/<story>/evidence/e2e-<attemptToken>/`. The evaluator supplies neither the report filename nor a duplicate evidence manifest. Files survive disposable scratch cleanup and are not nested in the fixer's worktree.

The harness derives the workflow result from this one report. Blocking product results enter the existing fixer/re-E2E loop; one repair cycle consumes one normal iteration. Blocked prerequisites and genuine Critical risks retain their normal authority. Reporting errors are not product defects or product repair rounds. If the evaluator cannot submit an accepted report, the workflow pauses with E2E interrupted; a normal resume retries the evaluator, even with zero product repair budget. Publication failure rolls back only files created by that publication, preserving the private submission and any existing or foreign files. Final assistant prose is not a second verdict source. Normal stage/final review reporting is unchanged.

### E2E fixer entrance

Automatic repairs and main-session `request_changes` use the same entrance. Each fresh or continued fixer receives the complete exact current report, its canonical path, and added change-request guidance. The Board uses that same report reference. There is no search for whichever JSON file looks newest, no reconstructed report excerpt, and no duplicate terminal evidence list. Supporting files remain read-only evidence, not instructions.

Older reports, state, counters and existing recovery eligibility are preserved. Missing historical provenance is not invented, and installing the tool does not automatically adopt discarded reports or resume an existing run.

The fixer should reproduce reported defects before patching. Unexecuted coverage and missing prerequisites are not themselves proof of product defects.

### Paused E2E and exhausted prerequisite attention

A pause prevents new scheduled work but permits an already active evaluator to settle. If it returns `needs_user`, the workflow can therefore move from paused to attention. A plain resume does not resolve that prerequisite.

When the user supplies genuinely new prerequisite authorization or guidance and E2E is already at or above its repair limit, use `request_changes` with `correction.attentionEpoch` and the exact `{ "kind": "e2e" }` target returned by status. Known `needs_user` attention can enter the bounded correction path without changing the failure label or resetting its repair count. Critical findings and unsafe/unknown cause provenance remain excluded. Existing public preflight and permission confirmation still apply; when attention is resolved, the normal public control resumes/advances the run. Cancelling confirmation launches nothing and leaves correction state unchanged.

Exercise a real evaluator paused before its terminal result, then let it settle `needs_user` at the repair limit. Confirm an exact-boundary correction carries both retained evaluator evidence and the new authorization into the next fixer, while stale/no-op requests and unsafe attention remain rejected. Preserve all earlier contributions, evidence and retry history; this grants one bounded repair, not a new automatic budget.

## Safety assertions

The exercise fails if the harness replays debug events, adopts a PID, tails a child file, relies on heartbeat recovery, claims graceful quit settlement, silently switches branches, discards dirty work, starts or resumes without required bypass confirmation, or authors evaluation/report/handoff resources.

Run deterministic repository checks after the exercise and keep generated benchmark output under ignored `.benchmark/`.
