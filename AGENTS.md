# PiBox Session Brief

PiBox is a deterministic workflow harness around a capable main orchestrator and persisted Pi subagents. The harness owns durable state, bounded context, lifecycle transitions, Git isolation, concurrency, integration, verification, and recovery. The orchestrator owns product and engineering judgment: it interprets evidence, resolves ambiguity, chooses allowed controls, and preserves user authority. Never bypass harness controls with manual task-state edits, routine Git switching, or hidden destructive recovery.

## Collaboration Flow

Work moves through free-form discussion → collaborative story/spec/design shaping → explicit review of the persisted story → executable delivery plan → explicit user-requested workflow run → staged implementation → managed review/fix loops → runtime-owned whole-branch journey verification and final review → completion. Never move from first persistence of a shaped story into delivery planning in the same turn; hand the story back for user review first. Clear local reversible edits may stay ad hoc. Planning does not authorize execution; a clear user request to start/run does. Routine ready work advances automatically. Material outcome, policy, privacy/security, irreversible, or destructive decisions return to the user.

## Context and Agent Model

Tasks are self-contained bounded context capsules. Each implementer receives the complete task contract and checks in persistent system context so compaction and resumed attempts do not erase the assignment; `task_clarify` is an explicit escape hatch for additional story context, not a substitute for a complete ticket. Reviewers receive the scoped task contracts plus full specification/design context and evaluate the checked-out implementation against that durable plan. Reviewer and fixer sessions persist across bounded iterations.

Reusable generic agent definitions live in `agent-definitions/`; workflow-only protocol and harness prompt fragments live in `prompt/`; on-demand workflows live in `skills/`. Use `general-purpose` for open-ended bounded delegation that may mix research, edits, commands, and tests; use narrower definitions when their contract fits. Children must not receive workflow orchestration or recursive subagent controls. Managed launches append protocol prompts to the selected generic definition. Keep prompt prose in Markdown rather than inline TypeScript. Configuration selects an agent definition and capability tier; each tier is an ordered list of concrete `provider/model#effort` routes, and the runtime resolves the first available pair and tools.

Delivery planning may define focused deterministic, regression, migration, or independent-review evaluations. It must not author final whole-branch journey verification or final branch review: the runtime inserts or semantically adopts those gates after assembly.

Path-scoped repository instructions live under `.claude/rules/` or `.pi/rules/` with Claude-compatible `paths:` frontmatter. Keep unconditional rules small; scoped bodies load after a matching file read instead of inflating initial context.

## Development and Evaluation

Run `npm run check`, `npm test`, and `git diff --check` before committing. For workflow scheduler, Git integration, recovery, protocol, or evaluation changes, also run `npm run eval:workflow`; use the opt-in Luna model suite only when model behavior needs measurement. Keep generated run artifacts under ignored `.benchmark/`, and update the reviewed baseline only after inspecting changed dimensions and retained findings.

Sound manifests may map user-supplied media, but copyrighted audio stays outside Git under the user's configured sound root.
