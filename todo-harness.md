# Harness TODO

Deferred ideas and follow-up work captured during the harness design brainstorm. These are not part of the currently approved design unless promoted by a later specification.

## Security and isolation

- Add OS-level filesystem sandboxing for task subagents.
  - Confine reads and writes to the assigned worktree and explicit capabilities.
  - Treat unrestricted `bash` as outside path-level `write`/`edit` enforcement.
  - Evaluate container, sandbox-exec, namespace, or other platform backends.
  - Keep the capability API stable so sandboxing can be added beneath it later.
- Add network isolation and per-role network policy for child agents.
- Add resource limits for child processes: runtime, CPU, memory, subprocesses, and output size.
- Harden the permanent private run archive.
  - Secret detection and redaction.
  - Avoid secrets in indexes and summaries.
  - Consider optional encryption at rest.
  - Audit file and directory permissions (`0600` files, `0700` directories).
- Threat-model untrusted task artifacts, tool results, imported skills, and prompts before they are reinjected into another agent.

## Private run archive management

- Add explicit inspect, export, redact, and delete commands.
- Add user-invoked cleanup by repository, work item, task, run, age, or size.
- Add archive size accounting and warnings without automatic deletion.
- Decide whether selected raw traces can be promoted into committed evidence safely.

## Visual interfaces

- Build a Kanban/dashboard view over `agent-artifacts/` after the artifact and task schemas stabilize.
- Revisit a full-transcript subagent sidebar if Pi exposes a public fullscreen dock/layout API.
  - Avoid modifying Pi upstream internals.
  - Keep the execution model independent of the eventual visual surface.
- Consider task dependency graphs, worktree state, evaluation results, and evidence browsing in the dashboard.

## Execution capabilities beyond the initial workflow

- Background/detached execution that survives the parent turn and process restart.
- Rich steering and task inbox controls beyond required context-update coordination.
- Nested delegation, enabled only for explicit orchestrator roles with depth and budget limits.
- Cross-project and cross-repository stories.
- Scheduled or recurring work.
- Remote workers and distributed execution.
- Additional work-item `kind` values beyond `change` and `story`.

## Model routing and capacity recovery

- Add automatic delayed resumption after every same-tier provider route is unavailable until a known reset.
- Add configurable provider cooldown windows and active health probes beyond the current response-driven circuit breaker.
- Consider budget-, quota-, latency-, and availability-aware routing after ordered same-tier runtime fallback proves stable.

## Git and workspace lifecycle

- Decide post-integration worktree and branch cleanup/retention policy.
- Design recovery for partially created, abandoned, or externally modified worktrees.
- Consider integration strategies beyond the initial orchestrator-controlled serial merge/cherry-pick flow.
- Handle non-Git projects or alternative VCS backends only if a real need emerges.

## Artifact interoperability

- Explore import/export or adapters for OpenSpec, Spec Kit, issue trackers, and existing Superpowers specs/plans.
- Consider publishing a tool-neutral artifact schema once the local format proves stable.
- Add migration/versioning support when the artifact schema evolves.
- Consider cross-linking project domain specs or ADR systems without duplicating them.

## Evaluation and harness improvement

- Build reusable trace-evaluation datasets from real harness runs.
- Calibrate evaluator prompts and model choices against human judgments.
- Compare harness versions, prompts, models, and scheduling policies through repeatable evals.
- Add human-approved retro/promotion from run findings into project rules, skills, and test knowledge.
- Periodically remove scaffolding that newer models no longer need; keep only empirically load-bearing harness behavior.
