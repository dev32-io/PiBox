# PiBox Session Brief

PiBox is a deterministic workflow harness around a capable main orchestrator and persisted Pi subagents. The harness owns durable state, bounded context, lifecycle transitions, Git isolation, concurrency, integration, verification, and recovery. The orchestrator owns product and engineering judgment: it interprets evidence, resolves ambiguity, chooses allowed controls, and preserves user authority. Never bypass harness controls with manual task-state edits, routine Git switching, or hidden destructive recovery.

## Collaboration Flow

Work moves through free-form discussion → collaborative shaping of a structured Markdown story and concise per-case E2E matrix → compilation and explicit review of the first persisted story → separately authored and compiled delivery plan → explicit user-requested start/resume → extension-owned bypass confirmation → ordered sequential/concurrent stages → runtime-owned whole-branch review → final E2E → completion. Story specification uses Outcome, Scope, Behavior, and Acceptance; design uses Approach, Boundaries and Flow, and Failure and Verification; each `E2E-NNN` case uses Exercise, Oracle, and Proof. Never move from first story persistence into delivery planning in the same turn. Clear local reversible edits may stay ad hoc. Compilation and planning do not authorize execution. Cancellation of bypass confirmation launches nothing. Routine work advances automatically; material outcome, policy, privacy/security, irreversible, destructive, or critical-risk decisions return to the user.

## Context and Agent Model

The main orchestrator authors through flat type-specific `story_write`, `e2e_write`, `task_write`, and `stage_write` tools. Cross-resource draft relationships may remain incomplete until near-zero-argument `workflow_compile` validates the current branch as a whole. A task is one self-contained YAML context capsule with metadata plus Markdown-rich `description`, `scope`, `delivery`, and deterministic `checks`. Workers receive the complete description, scope, and delivery in persistent system context; checks remain harness-owned. Outside the structural parent field, task prose contains no story/artifact references, narrative taxonomy, criterion IDs, or block IDs. `task_clarify` is an exceptional bounded line-read/literal-search surface over story `spec` or `design`, not a substitute for a complete task. Final E2E actors receive the complete rendered `e2e` field.

Plans contain ordered stages whose task sets run `sequential` or `concurrent`. Each stage may define deterministic checks and optional `review.mode`/`review.focus`, but plans never contain authored evaluations, reports, handoffs, repair tasks, or retry counts. Runtime-generated repair/review/E2E work is first-class state; only `.pi/harness.yaml` `limits.repairRounds` controls retries. The runtime owns whole-branch review before final E2E.

Reusable generic agent definitions live in `agent-definitions/`; workflow protocol fragments live in `prompt/`; on-demand workflows live in `skills/`. Use `general-purpose` for open-ended bounded delegation and narrower definitions when their contract fits. Children never receive workflow orchestration or recursive subagent controls. Managed launches append protocol prompts to the generic definition. Agent-definition frontmatter alone owns the base tool allowlist. Optional `mcp:<server>` entries rely on user-managed `pi-mcp-adapter`; missing servers degrade gracefully and child calls remain scoped to declared names.

## Persistence and Recovery

Each story keeps related resources together under `agent-artifacts/<story>/`: committed `story.yaml`, `plan.yaml`, and `tasks/*.yaml`; ignored runtime-owned `state.yaml`, `ledger.yaml`, and `events.jsonl`; and final `outcome.md` plus sanitized `evidence/` only when those outputs are consumed.

`state.yaml` is the sole scheduling, ownership, retry, Git, reviewed-contract-digest, metrics, resume, and outcome authority. Once initialized, authored story/plan/task mutations and digest drift are refused. This version has no in-place replan; a contract change requires explicit stop and a new target story. `ledger.yaml` is the small curated set of currently relevant non-obvious findings/evidence and the only rolling agent context. `events.jsonl` is coarse content-free debug/analytics logging only: never replay it, derive state from it, render it routinely, or inject it into prompts. Children write none of these files; one serialized workflow writer applies state atomically before best-effort debug append.

`/reload` is the only same-activation rebind through the process-global `SubagentService`. Treat quit as crash; users should not quit while work is running. A later activation interrupts and fences old attempts, pauses the workflow, preserves Git/worktrees, and starts only fresh attempts after explicit resume. Never add event replay, PID adoption, detached survival, file tails, or heartbeat recovery.

Path-scoped repository instructions live under `.claude/rules/` or `.pi/rules/` with Claude-compatible `paths:` frontmatter. Keep unconditional rules small; scoped bodies load after a matching file read.

Repository tool permissions live at `.pi/permissions.yaml`. Enforced mode applies allow/ask/deny; bypass skips only that gate. `Shift+Tab` toggles the visible session-scoped mode. Every child inherits its parent's mode. `workflow_start` and any resume that would launch children outside bypass use the extension-owned confirmation; Critical risk acceptance always has a separate explicit confirmation even in bypass. Cancellation launches nothing and mutates neither execution nor permission state.

## Development and Evaluation

Run `npm run check`, `npm test`, and `git diff --check` before committing. For scheduler, Git, recovery, protocol, or benchmark changes, also run `npm run eval:workflow`. Keep generated artifacts under ignored `.benchmark/` and update reviewed baselines only after inspection.

Sound manifests may map user-supplied media, but copyrighted audio stays outside Git under the configured sound root.
