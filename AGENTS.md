# PiBox Session Brief

PiBox is a deterministic workflow harness around a capable main orchestrator and persisted Pi subagents. The harness owns durable state, bounded context, lifecycle transitions, Git isolation, concurrency, integration, verification, and recovery. The orchestrator owns product and engineering judgment: it interprets evidence, resolves ambiguity, chooses allowed controls, and preserves user authority. Never bypass harness controls with manual task-state edits, routine Git switching, or hidden destructive recovery.

## Collaboration Flow

Work moves through free-form discussion → durable story/spec/design → executable plan → explicit user-requested workflow run → staged implementation → managed review/fix loops → E2E and full-branch review → completion. Clear local reversible edits may stay ad hoc. Planning does not authorize execution; a clear user request to start/run does. Routine ready work advances automatically. Material outcome, policy, privacy/security, irreversible, or destructive decisions return to the user.

## Context and Agent Model

Tasks are bounded context capsules. Each implementer receives its task brief, acceptance contract, relevant plan boundary, checks, and durable orchestrator responses in persistent system context so compaction and resumed attempts do not erase the assignment. Reviewers receive the scoped task contracts plus full specification/design context and evaluate the checked-out implementation against that durable plan. Reviewer and fixer sessions persist across bounded iterations.

Reusable agent definitions live in `agent-definitions/`; harness prompt fragments live in `prompt/`; on-demand workflows live in `skills/`. Keep agent behavior and prompt prose in those Markdown files rather than inline TypeScript. Configuration selects an agent definition, capability tier, and deliberation profile; the runtime resolves a concrete model and tools.

Run `npm run check`, `npm test`, and `git diff --check` before committing.
