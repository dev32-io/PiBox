# PiBox Managed Workflow Design Specification

**Status:** Simplified target contract

**Scope:** Story shaping, delivery planning, staged execution, persistence, verification, and recovery

## 1. Purpose and authority

PiBox combines a capable main-session orchestrator with deterministic workflow machinery:

> Models decide semantic work; capabilities enforce mechanical truth.

The orchestrator owns product and engineering judgment, ambiguity resolution, risk interpretation, and user conversation. The harness owns resource validation, durable state, child ownership, Git/worktrees, scheduling, integration, checks, bounded repair, review, E2E, metrics, and recovery.

Small local reversible work remains ordinary ad-hoc Pi work. Managed execution is for work that benefits from a reviewed contract and deterministic delivery controls.

## 2. Collaboration boundaries

```text
free-form product discussion
  → collaborative story shaping
  → first persistence of story.yaml
  → explicit user review of the persisted story
  → separate delivery planning
  → user review of plan.yaml and tasks
  → explicit user request to start or resume
  → extension-owned bypass confirmation
  → managed stages, whole-branch review, E2E, completion
```

The first story persistence and delivery planning never occur in the same turn. An end-to-end planning request does not waive this story-review boundary. Planning does not authorize execution. A clear request to start or resume the reviewed plan is the only conversational execution gate.

## 3. Authored resource model

### 3.1 Canonical layout

```text
agent-artifacts/<story>/
  story.yaml
  plan.yaml
  tasks/<task>.yaml
  state.yaml       # runtime-owned, ignored
  ledger.yaml      # runtime-owned, ignored
  events.jsonl     # runtime-owned, ignored
  outcome.md
  evidence/        # intentionally retained sanitized evidence only
```

Historical pre-target work items remain immutable history. Target resources have no compatibility fields. Legacy history, if readable, is isolated from executable state and is never mutated or silently reinterpreted.

### 3.2 Story

A story has identity and three Markdown-rich fields rendered from flat semantic authoring inputs:

```yaml
schemaVersion: 1
id: checkout
title: Reliable checkout
kind: story
spec: |
  # Spec
  ## Outcome
  A valid checkout creates one order.
  ## Scope
  Checkout submission, excluding settlement.
  ## Behavior
  Valid input succeeds; invalid input creates nothing.
  ## Acceptance
  Both results are externally observable.
design: |
  # Design
  ## Approach
  Use the existing checkout command.
  ## Boundaries and Flow
  The UI calls the command and renders its typed result.
  ## Failure and Verification
  Rejection does not persist; focused tests prove the invariant.
e2e: |
  # E2E
  ## Scope
  The disposable checkout journey.
  ## E2E-001 — Complete checkout
  ### Exercise
  Submit a disposable valid cart.
  ### Oracle
  One confirmation identifies one order.
  ### Proof
  Capture both and clean up.
```

Specification requires Outcome, Scope, Behavior, and Acceptance. Design requires Approach, Boundaries and Flow, and Failure and Verification. E2E has global Scope, optional Exclusions, and independently addressed stable `E2E-NNN` cases containing Exercise, Oracle, and Proof. Bodies remain free-form Markdown; no criterion taxonomy, block IDs, dimensional artifacts, or verbose case schema is added. Consequential decisions live in the relevant spec or design prose rather than separate decision resources.

### 3.3 Task

Each task is one concise self-contained YAML context capsule:

```yaml
schemaVersion: 1
id: submit-checkout
title: Submit checkout
dependsOn: []
description: Free-form contribution and necessary context.
scope: Free-form ownership, exclusions, interfaces, and integration boundary.
delivery: Free-form implementation, observable result, focused proof, and repository-state expectation.
checks:
  - npm test -- checkout-command
assignment:
  agent: implementer
  tier: medium
  rationale: A bounded task at an existing seam.
  # tierJustification: Required for high/max.
```

Semantic tiers are `local | low | medium | high | max`; `local` requires recorded current user permission. Outside its structural parent field, task prose contains no story references, artifact refs, criteria refs, narrative taxonomy, acceptance blocks, or separate brief/acceptance files. The complete `description`, `scope`, and `delivery` are injected into stable worker system context. `checks` are harness-owned deterministic commands rather than prose evidence claims.

### 3.4 Plan

`plan.yaml` is the separate reviewed execution topology:

```yaml
schemaVersion: 1
stages:
  - id: checkout-delivery
    mode: sequential
    tasks: [submit-checkout]
    checks: [npm test -- checkout-command]
    review:
      mode: required
      focus: Checkout persistence and typed failure behavior
```

Stages are ordered. Each task set runs `sequential` or `concurrent`. A stage may omit review policy or declare `review.mode: required | skip` and optional free-form `review.focus`. Plans never contain `maxIterations`, repair rounds, evaluation resources, evaluator tasks, repair tasks, reports, handoffs, or authored final outcome projections. `.pi/harness.yaml` `limits.repairRounds` is the only retry-limit authority. Once execution initializes, state pins the reviewed story/plan/task digests; authored mutations and digest drift are refused. This version has no in-place replan; a contract change requires explicit stop and a new target story.

## 4. Context and child ownership

A managed child launch has stable generic agent instructions, workflow protocol, selected authoritative context, and a short attempt-specific user turn. Stable prefixes remain byte-stable across attempts when the contract is unchanged.

- Implementers receive complete task description/scope/delivery; checks remain separate harness contract.
- `task_clarify` provides bounded line reads and case-insensitive literal search over the selected free-form story `spec` or `design`, with range, match, and truncation metadata. It does not browse artifacts, task refs, reports, or evaluations.
- Reviewers and fixers receive scoped task contracts, optional review focus, current findings/failure, relevant curated ledger entries, and complete story context required by their boundary.
- Final E2E actors receive the story's complete `e2e` field directly.
- Debug events are never child context.

The standalone `SubagentService` owns generic agent definitions, process launch, normalized live events, process groups, and activation-local delivery. Workflow depends on that service; dependency never reverses. Children do not receive workflow orchestration or recursive delegation controls and never write canonical/runtime workflow files.

## 5. Stage-centric scheduler

The reviewed plan is an ordered stage train:

- **Sequential stage:** tasks run serially in one isolated stage workspace. Each later task sees prior task commits, and the barrier integrates the ordered contribution once.
- **Concurrent stage:** independent tasks run in per-task worktrees from one pinned base. All contributions cross one deterministic integration barrier before any later stage starts.

Within each stage:

```text
task implementation and task checks/repairs
  → deterministic integration
  → stage checks
  → optional planned review/fix loop
  → stage complete
```

After all stages:

```text
whole-branch review of execution-start..current
  → whole-branch fixes/re-review when needed
  → final E2E from story.e2e
  → E2E fixes/recheck when needed
  → outcome.md
```

Routine task, integration, check, repair, review, re-review, final-review, and E2E transitions advance automatically. Runtime-generated CI repair, integration repair, stage reviewer/fixer, whole-branch reviewer/fixer, and E2E/fixer work are first-class slots in state—not authored tasks or resources.

The orchestrator is involved only for contradictory authority, critical/material risk, explicit risk acceptance, unsafe/destructive recovery, unanswerable clarification, consequential user-owned decisions, or exhausted configured retries.

## 6. Story-local runtime authority

### 6.1 State

`state.yaml` is the sole authority for:

- workflow/stage/task/review/E2E scheduling;
- active slot ownership and opaque attempt tokens;
- retry counts and interruption status;
- Git branches, commits, and worktree coordinates;
- pinned digests of the reviewed story, plan, and every task contract;
- pause/resume and outcome status;
- current structured findings needed for control;
- cumulative metrics and one open metric clock.

State replacement is atomic. There is no global workflow generation; each active slot has an opaque attempt token and activation owner used to reject stale callbacks.

### 6.2 Ledger

`ledger.yaml` is a small rewritten collection of currently relevant non-obvious findings and evidence. It is the only rolling agent handoff context. Entries are curated/upserted/pruned rather than an append-only activity feed. Routine scheduler transitions, checks, status, and completion notices never enter it.

### 6.3 Debug journal

`events.jsonl` is coarse debug/analytics logging only. It may record workflow/stage/task/integration/check/review/repair/E2E/subagent boundaries, durations, routes, usage, and compact result codes.

It never stores prompts, outputs, user content, finding bodies, reports, state patches, control mutations, credentials, or secrets. Startup never replays it. State, metrics, prompts, child context, normal status, tools, and TUI rendering never derive from or include it. Only an explicit bounded filtered diagnostic read may expose it to the orchestrator.

One serialized workflow writer owns state, ledger, and debug appends. It applies authoritative state first, then best-effort appends the corresponding debug event. A missing final event is acceptable; missing state is not.

## 7. Git and integration safety

Sequential tasks share one repository-local ignored stage worktree under exclusive scheduler ownership. Concurrent tasks use separate repository-local ignored worktrees:

```text
<repository>/.worktree/pibox/<story>/<task>/
```

The harness validates the persisted canonical feature/fix branch at start, resume, and every canonical action, plus pinned bases, task ownership, contribution commits, and integration barriers. Canonical repairs are serialized and must preserve ancestry, avoid harness-owned paths, and produce only a validated committed diff. It never auto-stashes, auto-resets, discards dirty work, routinely switches branches, or invisibly resolves conflicts. Failed integration preserves task branches/worktrees and the last authoritative state for safe recovery.

## 8. Verification and repair

Deterministic task and stage checks are authored commands. Stage review is optional reviewed policy, selected by risk, observability, reversibility, and boundary crossings. Regardless of stage policy, the runtime performs whole-branch review before final E2E.

Repairable non-critical task, integration, verification, review, and E2E failures automatically enter the matching runtime repair slot. Retry budgets come only from `limits.repairRounds`. Exhaustion never silently waives a blocking failure. Critical risk acceptance and material policy/security/privacy/destructive decisions return to the user.

Structured findings required for control remain in state. Only intentionally retained sanitized evidence is written beneath `evidence/`. There are no authored evaluations, report files, attempt reports, evaluation handoffs, or duplicated evidence projections. Completion writes one user-facing `outcome.md`.

## 9. Permission safety gate

Repository tool permission policy lives at `.pi/permissions.yaml`. Enforced mode applies allow/ask/deny; bypass skips only this policy gate.

`workflow_start` performs side-effect-free topology, branch, command, environment, and contract validation before presenting the extension-owned confirmation for unattended bypass. Cancellation launches nothing and does not mutate execution or permission state. The same guard applies to every resume that would launch children when the current activation is not already in bypass. Critical-risk approval always requires a separate explicit user confirmation, even in bypass. Children inherit the visible parent mode.

Bypass never bypasses workflow authority, Git isolation, reviews, verification, or recovery. A new activation cannot silently resume into enforced mode.

## 10. Activation, reload, quit, and recovery

Children belong to one activation. `/reload` is the only same-activation rebind path. A new runner may rebind matching active attempts held by the process-global `SubagentService` using workflow/attempt metadata and bounded current/terminal delivery; the metric clock stays open. No file replay is involved.

Session quit is treated exactly like process crash. Pi cannot reliably await managed settlement during quit, and users should not quit while workflows run. On owner loss, the lifetime wrapper terminates child process groups, but the exact exit event/time may be absent.

During startup of the next activation, before status can remain falsely running and before any explicit resume, the harness:

1. compares durable owner identity;
2. marks old running slots interrupted;
3. permanently fences old attempt tokens;
4. pauses the workflow;
5. closes metrics only through the last durable checkpoint and marks an incomplete interval;
6. appends synthetic coarse recovery/debug boundaries;
7. preserves all Git/worktree state;
8. launches fresh attempts only after explicit resume and any required bypass confirmation.

It never adopts prior children, replays events, scans PIDs, tails files, adds heartbeat recovery, or promises detached survival.

## 11. Metrics and TUI

State stores cumulative workflow time, five exclusive category totals, and at most one open `{ category, since }` clock. Categories are `implementation`, `integration`, `verification`, `review`, and `e2e`. Category totals partition workflow wall time; parallel agents never multiply elapsed time.

The TUI projects live time in memory as stored base plus `now - since`. It never samples time into state or reads the debug journal. Time persists only on an existing state transition, pause/interruption, category transition, or completion. Incomplete crash intervals render with `+`.

The primary workflow projection is stage-centric, showing current stage/tasks and review-loop position rather than a generic generated-step list.

## 12. Capability and configuration boundaries

Main-session resource tools manage stories, tasks, and stages. Generic `subagent_spawn` handles ad-hoc bounded delegation only; managed task/review/repair/E2E attempts are internal scheduler launches through `SubagentService`.

Agent-definition Markdown frontmatter owns base tools and default tier. Plans select semantic task tiers; `.pi/harness.yaml` maps each tier to ordered concrete `provider/model#effort` routes. Optional `mcp:<server>` selectors rely on user-managed adapter configuration and degrade gracefully when unavailable.

The main model-facing controls remain minimal: inspect status, start, pause, resume, stop, recover, and complete through state-backed capabilities. No control mutates state by editing files directly.

## 13. Completion criteria

A target-schema workflow completes only when:

1. every authored task is integrated through its stage;
2. every deterministic task/stage check is settled;
3. required stage review loops are settled;
4. whole-branch review is settled;
5. final E2E covers the complete story `e2e` contract;
6. no blocking finding remains or is silently waived;
7. canonical Git state is clean and recorded;
8. `outcome.md` records delivered behavior, checks, review/E2E results, deviations, and residual risk.

The working branch is reported ready for the user's normal merge/PR process without routine switching or automatic merging.

## 14. Non-goals

- OS-level sandboxing.
- Nested worker delegation.
- Event-sourced recovery or metrics.
- PID/process adoption across activations.
- Detached child survival after owner loss.
- Heartbeat recovery or file-tail observers.
- Authored evaluation/report/handoff resources.
- Automatic destructive Git cleanup.
- Silent compatibility execution of historical work items.
- Replacing ordinary ad-hoc Pi usage.
