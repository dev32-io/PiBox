# Orchestration and session-agent registry design

## Design goal

Add product-partner planning behavior and durable direct-child supervision without turning discovery into universal ceremony, weakening canonical authority, or coupling child survival to the lifetime of the main Pi process.

## Chosen approach

Use two cooperating layers:

1. A semantic orchestration layer for outcome discovery, upstream challenge, proportional planning, explorer assignment, and user decisions.
2. A deterministic session-agent runtime for identity, sixteen-slot accounting, depth enforcement, process attempts, file-backed output, structured messages and handoffs, recovery, and listing.

Semantic public capabilities remain purpose-specific. They construct typed assignments and delegate process creation to one internal launch coordinator. Child capabilities write only to immutable scoped storage and assigned workspaces. Canonical reconciliation remains a main-session responsibility.

Binding lifecycle details are defined by `active-agent-slot-accounting` and `background-agent-liveness`.

## Product-partner prompt contracts

The always-loaded orchestrator contract seeks the outcome behind a proposed solution, inspects facts independently, steps back on material framing risk, challenges inherited product and technical premises constructively, stops discovery at the materiality boundary, and preserves user decision ownership.

The planning skill applies this to stories, changes, bugs, diagnostics, and incidents. It distinguishes mitigation, diagnosis, repair, and prevention. Delegation is used only when context isolation, specialist capability, independent evidence, or contribution size repays coordination overhead.

The plan critic checks goal-to-solution alignment, provenance of decisions, upstream product assumptions, material hidden cases, contribution coverage, delegation economics, dependency edges, integration boundaries, and verification credibility. Behavioral scenarios evaluate observable decisions and tool use rather than wording.

## Explorer protocol

A typed exploration assignment contains:

```ts
interface ExplorationAssignment {
  schemaVersion: 1;
  mode: "lookup" | "map" | "trace" | "impact" | "diagnose" | "explain";
  question: string;
  decisionSupported: string;
  knownEvidence: Array<{ source: string; observation: string }>;
  scope: { start: string[]; exclude?: string[] };
  depth: "quick" | "standard" | "thorough";
  stopConditions: string[];
  requiredOutput: string[];
}
```

`exploration_launch` validates the assignment, resolves the explorer model, reserves the logical agent, and invokes the shared coordinator. Direct code-understanding requests use the same capability without a managed work item.

Explorer child capabilities are:

```text
exploration_context
exploration_checkpoint
exploration_blocked
exploration_complete
```

Mode-sensitive completion records a direct answer, observed system, precise evidence, relevant behavior or data flow, working comparisons, hypotheses with supporting and conflicting evidence, change implications, material hidden cases, and remaining unknowns or next probe as applicable. One bounded protocol nudge may create another process attempt under the same logical agent; persistent invalid output becomes protocol failure.

## Session identity and private layout

Read the stable UUID from Pi's session header and combine it with repository identity. `/reload` and continuation reuse the registry; new and forked sessions create distinct registries.

```text
~/.pi/agent/harness/repositories/<repo-id>/sessions/<session-id>/
├── session.yaml
├── agents.yaml
├── agent-events.jsonl
├── registry.lock
└── agents/<agent-id>/
    ├── assignment.json
    ├── attempts/<attempt-id>/
    │   ├── attempt.yaml
    │   ├── heartbeat.json
    │   ├── stdout.log
    │   ├── stderr.log
    │   └── transcript.jsonl
    ├── checkpoint.json
    ├── messages/
    └── handoff.json
```

No separate agent `kind` is stored. Role is authoritative for behavior and display. Optional work-item, task, evaluation, run, and workspace references support navigation.

## SessionAgentRegistry

The registry snapshot is authoritative for logical agents and current state. The event file records ordered transitions for observability and a future TUI.

The main agent has depth zero and direct children depth one. A depth-two request fails before reservation. A logical agent atomically reserves one of sixteen slots before its first process attempt and retains it through every nonterminal state, including waits, pauses, interruption, recovery, and reported handoff. Later attempts reuse the existing reservation. Only completed, failed, protocol-failed, or cancelled transitions release the slot.

A session-scoped cross-process mutex serializes each registry transaction:

1. Acquire a lock with owner metadata and safe stale-owner recovery.
2. Read and validate snapshot revision.
3. Validate credential, depth, slot count, idempotency key, and state transition.
4. Apply the update and increment snapshot revision and event sequence.
5. Atomically replace the snapshot.
6. Append the sequenced lifecycle event.
7. Release the lock.

A snapshot written without its event because of a crash remains authoritative; reconciliation appends a synthetic recovery event. Replay cannot reserve twice or finalize twice.

## LaunchCoordinator

All model-backed launches call one internal coordinator:

```ts
launch(input: {
  role: string;
  assignment: unknown;
  model: ResolvedModel;
  tools: string[];
  workspace: string;
  scope: AgentScope;
  completionContract: CompletionContract;
}): Promise<SessionAgentRecord>
```

Semantic wrappers remain for `agent_run`, `exploration_launch`, `task_launch`, `evaluation_launch`, and repair launch. The coordinator reserves and registers before spawning. Spawn failure becomes a durable terminal failure rather than deleting the record.

Each process attempt has a random immutable attempt ID and scoped credential. Children receive root session, logical agent, parent, depth, attempt, and run scope through protected environment variables. A protocol nudge or recovery attempt remains under the same logical agent.

## File-backed background execution

Children run in independent process groups with stdout and stderr directed to attempt files. Transcript and lifecycle events, five-second heartbeat, checkpoints, messages, and handoffs are written directly to private files. The main process tails those files when present; children do not depend on a writable parent pipe or synchronous RPC.

Main-process exit does not terminate children. Child credentials authorize only one assignment's private records, structured messages and handoff, and assigned workspace. Canonical artifact and child-launch capabilities remain unavailable.

A fresh heartbeat matching logical agent and process-attempt identity proves recent liveness. PID existence without a fresh matching heartbeat is ambiguous and becomes `recovery_required`; V1 performs no platform-specific process-start fingerprinting, automatic kill, or duplicate launch.

## Asynchronous messages

Immutable messages have stable IDs, agent and assignment references, type, status, blocking semantics, summary, rationale, evidence, options, recommendation, checkpoint linkage, and timestamps.

- `decision_report` is non-blocking and remains attached to final handoff.
- `change_request` checkpoints safe work, transitions to `waiting_decision`, and exits.
- `blocked` checkpoints work, records evidence, enters blocked state, and exits.

Main-session absence does not affect persistence. An orchestrator response is linked by message ID. A later attempt receives the original assignment, current authoritative context, retained workspace, checkpoint, request, and response. Messages never mutate canonical planning automatically.

## Handoffs and reconciliation

Every role writes a typed terminal or recoverable handoff. A child that finishes writes it atomically and enters `reported`; it does not finalize canonical state.

At session startup and before dependent lifecycle mutations, idempotent reconciliation:

1. Checks pending messages and handoffs before process liveness.
2. Validates and finalizes a valid handoff, then marks completed.
3. Preserves a positively identified live child and resumes file observation.
4. Marks a confirmed-dead child without handoff interrupted while retaining workspace and records.
5. Marks ambiguous identity recovery-required and prevents duplicate writing.
6. Surfaces open blocking messages before dependent execution continues.

Task reconciliation retains Git, clean-worktree, planning-revision, commit, and canonical-artifact checks. Evaluators retain evidence and finding checks. Explorers use mode-sensitive completion validation.

Capacity or model unavailability ends the current process attempt, retains the logical slot in `waiting_capacity` or `waiting_model`, and requires explicit resume. V1 has no automatic delayed retry.

## Explicit control

`agent_control` addresses logical agent IDs for pause, resume, stop, and message response. Stop targets only a positively identified process group, atomically records intent, preserves files, and transitions deterministically. Session shutdown itself does not stop children.

## Failure and recovery

- Stale registry lock: recover only after validating the owner is no longer active.
- Crash before spawn: reconcile stale reservation to terminal failure or interruption.
- Crash between snapshot and event append: synthesize the missing event.
- Main exit: child continues file-backed work without gaining canonical authority.
- Child exits after handoff: resumed main validates and finalizes.
- Child exits before handoff: preserve interrupted state.
- Stale heartbeat with an existing PID: require explicit recovery.
- Planning revision changes: reject stale terminal completion while preserving checkpoint and messages.
- Output storage failure: no valid completion claim without the structured handoff.

## Security and privacy

Registry, transcripts, outputs, credentials, messages, and checkpoints remain outside Git with restrictive permissions. Durable credentials are hashed. Child credentials are scoped to one attempt and assignment. Children cannot launch agents or mutate canonical artifacts.

## Compatibility and migration

Existing work-item run records remain readable. New registry records may link to legacy run IDs; old records are not moved or deleted. Existing public tool names remain while process mechanics converge behind the coordinator. Configuration gains defaults of sixteen active logical agents and depth one without requiring immediate repository-policy edits.

## Verification boundaries

- Prompt scenarios: feature framing, product-foot-gun challenge, low-risk proportionality, bug diagnosis, and delegation restraint.
- Unit tests: explorer schemas, mode completion, registry transactions, state transitions, slot/depth enforcement, credentials, messages, locking, and replay.
- Process integration: concurrent reservation, background completion after parent exit, explicit stop, later attempt, stale heartbeat ambiguity, and resume reconciliation.
- Lifecycle regression: task, evaluation, repair, direct specialist, approval, integration, and completion behavior.
- Final E2E: launch explorer and task children, exit main, allow a handoff and blocking request, resume the same session, respond, reconcile, evaluate, and complete.

## Alternatives considered

- Separate role registries: rejected because accounting and recovery would diverge.
- Only one generic public launch tool: rejected because semantic wrappers provide better typed guidance.
- Separate diagnostic role: deferred until explorer-mode evaluation demonstrates a need.
- Stop children on main exit: rejected because work is isolated and file-backed.
- Reattach old streams: rejected because durable files provide reliable recovery.
