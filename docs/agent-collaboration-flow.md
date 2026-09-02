# Agent Collaboration and Development Flow

## Purpose

PiBox should feel like collaboration with a capable product and technical partner. Conversation stays free until the user chooses convergence; deterministic workflow machinery begins only after reviewed contracts exist.

```text
free-form product discussion
  → high-level story shaping
  → explicit review of the first persisted story
  → technical delivery planning
  → explicit user request to run or resume
  → managed execution
  → outcome briefing
```

New evidence may move work backward to the phase that owns the unresolved question.

## 1. Free-form product discussion

Start from the user's ideas and observed problems. Recover the outcome behind a proposed mechanism, inspect facts when useful, compare meaningful alternatives, and challenge material risk without taking authority away. The conversation can last many turns or end without any workflow artifact.

Ordinary discussion does not authorize story persistence, planning, or execution. When common ground emerges, offer to shape the behavior and high-level design; do not bundle shaping and delivery planning into one invisible transition.

## 2. Story shaping

Collaboratively define the durable product/technical contract before task decomposition. The deliverable is one Markdown-rich story with a compact required structure:

- `spec`: Outcome, Scope, Behavior, and Acceptance;
- `design`: Approach, Boundaries and Flow, and Failure and Verification;
- `e2e`: global Scope, optional Exclusions, and independently addressable stable `E2E-NNN` cases with Exercise, Oracle, and Proof.

These headings establish durable meaning without restoring criterion taxonomies, block IDs, dimensional artifacts, or verbose case metadata. Bodies remain free-form Markdown scaled to the story.

Before persistence, present the complete story checkpoint for user validation. Write semantic fields through flat `story_write` and per-case `e2e_write`, read them back, and call validation-only `workflow_compile`. After first successful compilation, present the story with its resource ref and stop. The user must explicitly review or request planning in a later turn. This remains true even when the initial request asked for an end-to-end plan.

Story shaping does not define tasks, stages, assignments, authored evaluations, reports, handoffs, or runtime repair policy.

## 3. Delivery planning

Planning begins only after explicit review of the persisted story. Inspect the repository and turn the story into coherent fresh-agent assignments.

Each task is one YAML context capsule with metadata and free-form `description`, `scope`, and `delivery`, plus deterministic `checks`. It contains no story/artifact/block references or narrative taxonomy. Coupled discovery, invariants, implementation, and focused proof stay together; proof-only/review-only/repair-only tasks are forbidden.

Arrange tasks in ordered stages:

- `sequential` stages run serially in one isolated stage workspace and pass prior commits forward before the integration barrier;
- `concurrent` stages fan independent compatible tasks from one pinned base and integrate them through one barrier.

A stage may add deterministic checks and optional `review.mode`/`review.focus`. The planner never authors evaluations, reports, handoffs, runtime repair tasks, or retry limits. Only harness `limits.repairRounds` controls repair attempts. The runtime owns whole-branch review and final E2E.

Write one flat task or stage at a time through `task_write` and `stage_write`; incomplete cross-resource relationships may remain during drafting. Call near-zero-argument `workflow_compile` when coherent so it can aggregate topology errors without receiving authored content. Present the successfully compiled plan for user review. Compilation or praise does not execute. The sole execution gate is a clear user request to start or resume.

## 4. Managed execution

Start/resume uses the extension-owned permission-bypass confirmation before launching unattended children whenever the current session is not already in bypass. Cancellation launches nothing.

The runtime advances ordered stages through implementation/check repair, integration, stage checks, optional stage review/fix, whole-branch review/fix, and final E2E/fix. The main session does not reproduce the scheduler. It intervenes only for contradictory authority, material user-owned decisions, critical risk, unsafe/destructive recovery, unanswerable clarification, or exhausted retries.

Workers receive complete task description/scope/delivery in stable context. `task_clarify` is an exceptional bounded line-read/literal-search surface over story `spec` or `design`. Final E2E receives `e2e` directly.

Completion produces one `outcome.md` and a briefing covering delivered behavior, checks, review/E2E, deviations, residual risk, and branch state. There are no duplicate authored evaluations, reports, or handoffs.

## Authorization and continuity

- Authorization belongs to phases, not acknowledgements.
- First story persistence always returns to user review before planning.
- Planning never authorizes execution.
- Start and resume require a clear user request and any required bypass confirmation.
- Material outcome, scope, policy, privacy/security, irreversible, destructive, or critical-risk decisions return to the user.
- New evidence returns to the phase that owns it rather than being buried downstream.

## Skill design principles

1. One primary job and deliverable per skill.
2. Clear trigger boundaries between discussion, shaping, planning, and execution.
3. Markdown-rich structured story prose; minimal task context; deterministic runtime state.
4. Progressive disclosure rather than one giant always-loaded prompt.
5. Preserve conversational momentum without leaking authorization across gates.
6. Escalate uncertainty to its owner.
7. Let mechanics enforce truth without replacing judgment.
8. Remove obsolete compatibility instructions rather than teaching both models.

## Regression questions

- Can the user discuss freely without workflow pressure?
- Is story shaping explicit, collaborative, structured, and still Markdown-rich?
- Does first persistence stop for user story review?
- Are story and plan separate review boundaries?
- Are tasks minimal, complete fresh-agent contexts without narrative refs?
- Are stages maximally safe concurrent or honestly sequential?
- Are reviews risk-selected and retry limits harness-only?
- Does planning avoid authored evaluations/reports/handoffs?
- Does execution require explicit start/resume and bypass confirmation?
- Does runtime authority remain state → curated ledger → debug-only journal?
- Are quit/crash and fresh-attempt recovery described honestly?
- Does completion rely on fresh authoritative evidence and one outcome?
