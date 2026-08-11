## Problem

The harness orchestrator and planner can turn a requested solution into a complete execution contract, but they do not yet behave consistently as a constructive product and technical partner. They may optimize within a user's initial framing instead of recovering the underlying outcome, challenging product or interaction assumptions that manufacture technical failures, or using repository evidence to expose consequential hidden cases. Subagent launching, lifecycle tracking, exploration handoffs, background continuation, and worker-to-orchestrator messages are also fragmented across role-specific paths, which limits robust recovery and a future unified TUI.

## Desired Outcome

PiBox supports collaborative outcome discovery for stories, changes, bug clusters, and diagnostic work; proportionate technical planning; a mode-aware read-only explorer with typed assignments and structured handoffs; and one durable session-scoped registry that atomically tracks every direct child subagent across launch, background continuation, messaging, completion, interruption, and resume.

## Scope — Included

- Refine the always-loaded orchestrator and planning contracts around constructive challenge, outcome framing, adaptive step-back behavior, evidence gathering, material hidden cases, and user-owned consequential decisions.
- Treat inherited product, UX, UI, domain, API, and technical premises as revisitable decisions when evidence shows disproportionate complexity or contradictory guarantees.
- Support feature, change, bug-fix, bug-cluster, incident-mitigation, diagnostic, and code-understanding entry points without forcing all work through one discovery depth.
- Evolve the existing explorer into a mode-aware read-only code-intelligence specialist with typed assignment envelopes, structured completion, protocol nudges, and direct user-facing explanation support.
- Route all model-backed child launches through one internal coordinator while preserving semantic public capabilities for exploration, tasks, evaluations, repairs, and direct specialists.
- Add an atomic private registry keyed to the stable main Pi session identity, with the main session at depth zero and direct children at depth one.
- Enforce at most 16 active subagents per main session and prohibit recursive subagent spawning.
- Make child progress, transcripts, checkpoints, messages, process attempts, and handoffs file-backed so subagents can continue after the main Pi process exits.
- Add durable asynchronous subagent-to-orchestrator decision reports, change requests, blockers, and orchestrator responses.
- Reconcile alive, reported, interrupted, and uncertain subagents when the same Pi session resumes.
- Preserve sufficient stable lifecycle references and events for a later subagent status dashboard or dialog.

## Success Signals

- Behavioral prompt scenarios show the orchestrator challenges solution fixation and upstream product assumptions when material, while avoiding unnecessary discovery ceremony.
- Feature and bug/diagnostic scenarios both produce evidence-backed shared understanding before canonical planning.
- Explorer scenarios return mode-appropriate cited evidence through typed completion and receive protocol nudges for missing required output.
- Every child launch appears atomically in one session registry with role, model, scope, process attempt, lifecycle state, and durable output locations.
- A seventeenth active child and every depth-two launch fail deterministically before process creation.
- The main process can exit while children continue, and resuming the same Pi session reconciles valid handoffs without duplicate writers or lost messages.
- Blocking change requests survive main-session absence and are surfaced for response on resume; non-blocking decision reports remain attached to the final handoff.
- Existing managed task, evaluator, approval, canonical-artifact, recovery, and schema-v1 compatibility behavior remains valid.

## Scope — Excluded

- Building the final subagent dashboard or fleet-management TUI.
- Recursive or peer-to-peer subagent delegation.
- Cross-machine or remote-agent execution.
- Reattaching in-memory stdout pipes or preserving provider model context across process restart.
- Automatic acceptance of worker-proposed product, design, or canonical contract changes.
- OS-level sandboxing beyond existing capability and workspace restrictions.
- A cancellable pre-quit dialog, because the current Pi extension API has no pre-shutdown cancellation hook.

## Constraints

- Models make semantic judgments; deterministic capabilities enforce identity, depth, active-agent limits, state transitions, credentials, file scope, and handoff validity.
- The main session remains the only user-facing orchestration and canonical-artifact authority.
- Product discovery remains proportional: continue only while an unresolved question could materially change outcome, scope, architecture, product or UX contract, delivery topology, verification, rollout, or recovery.
- Parallelism and delegation are optional techniques whose context and coordination overhead must be justified; they are not optimization metrics.
- Background children must not depend on parent-owned output pipes or a live main-session RPC channel.
- Private registry and run data remain outside Git; canonical planning and outcome artifacts remain committed.
- Existing external or legacy run records remain recoverable without destructive migration.

## Assumptions

- The stable session UUID stored in Pi's session header is available or can be safely derived during session startup.
- Direct children can write only their scoped private records, structured handoffs, and assigned workspaces after the main process exits.
- Interactive quit defaults to allowing children to continue; explicit stop controls remain available before exit and after resume.
