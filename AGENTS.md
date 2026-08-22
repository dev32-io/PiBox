# PiBox Session Brief

PiBox is a deterministic workflow harness around a capable main orchestrator and persisted Pi subagents. The harness owns durable state, bounded context, lifecycle transitions, Git isolation, concurrency, integration, verification, and recovery. The orchestrator owns product and engineering judgment: it interprets evidence, resolves ambiguity, chooses allowed controls, and preserves user authority. Never bypass harness controls with manual task-state edits, routine Git switching, or hidden destructive recovery.

## Collaboration Flow

Work moves through free-form discussion → collaborative story/spec/design shaping → explicit review of the persisted story → executable delivery plan → explicit user-requested workflow run → extension-owned bypass confirmation → staged implementation with risk-selected review/fix loops → runtime-owned whole-branch review → whole-branch journey verification → completion. Never move from first persistence of a shaped story into delivery planning in the same turn; hand the story back for user review first. Clear local reversible edits may stay ad hoc. Planning does not authorize execution; a clear user request to start/run does. `workflow_start` then asks the user to confirm the visible permission bypass required for unattended execution; cancellation launches nothing. Routine ready work advances automatically. Material outcome, policy, privacy/security, irreversible, or destructive decisions return to the user.

## Context and Agent Model

Tasks are self-contained bounded context capsules. Each implementer receives the complete task contract and checks in persistent system context so compaction and resumed attempts do not erase the assignment; `task_clarify` is an explicit escape hatch for additional story context, not a substitute for a complete ticket. Reviewers receive the scoped task contracts plus full specification/design context and evaluate the checked-out implementation against that durable plan. Reviewer and fixer sessions persist across bounded iterations.

Reusable generic agent definitions live in `agent-definitions/`; workflow-only protocol and harness prompt fragments live in `prompt/`; on-demand workflows live in `skills/`. Use `general-purpose` for open-ended bounded delegation that may mix research, edits, commands, and tests; use narrower definitions when their contract fits. Children must not receive workflow orchestration or recursive subagent controls. Managed launches append protocol prompts to the selected generic definition. Keep prompt prose in Markdown rather than inline TypeScript. Configuration selects an agent definition and capability tier; each tier is an ordered list of concrete `provider/model#effort` routes, and the runtime resolves the first available pair. Agent-definition frontmatter alone owns the base tool allowlist; harness YAML tool entries are ignored. Optional `mcp:<server>` entries stay in the normal agent `tools` field and rely on user-managed `pi-mcp-adapter` configuration; missing servers must degrade gracefully, and child proxy calls remain scoped to the declared names.

Delivery planning may define focused deterministic, regression, or migration checks and explicit required/skipped stage-review policy, but never evaluation resources. The runtime owns exact execution-start-to-current whole-branch review before final journey verification.

Path-scoped repository instructions live under `.claude/rules/` or `.pi/rules/` with Claude-compatible `paths:` frontmatter. Keep unconditional rules small; scoped bodies load after a matching file read instead of inflating initial context.

Repository tool permissions live at `.pi/permissions.yaml`. Enforced mode applies allow/ask/deny policy decisions; bypass skips only that gate and never bypasses harness controls. `Shift+Tab` toggles the visible session-scoped mode. Every spawned child inherits its parent's mode, and managed workflows enter bypass only after the user accepts the extension-owned `workflow_start` confirmation.

## Development and Evaluation

Run `npm run check`, `npm test`, and `git diff --check` before committing. For workflow scheduler, Git integration, recovery, protocol, or evaluation changes, also run `npm run eval:workflow`; use the opt-in Luna model suite only when model behavior needs measurement. Keep generated run artifacts under ignored `.benchmark/`, and update the reviewed baseline only after inspecting changed dimensions and retained findings.

Sound manifests may map user-supplied media, but copyrighted audio stays outside Git under the user's configured sound root.
