# Orchestration and session-agent registry design

## Design goal

Add product-partner planning behavior and durable direct-child supervision without turning discovery into universal ceremony, weakening canonical authority, or coupling child survival to the lifetime of the main Pi process. One shared private registry and launch coordinator must support all specialist roles and provide a stable future TUI source.

## Chosen approach

Use two cooperating layers:

1. A semantic orchestration layer that guides outcome discovery, upstream challenge, proportional planning, explorer assignment, and user decisions.
2. A deterministic session-agent runtime that owns identity, slot reservation, process attempts, file-backed output, structured messages and handoffs, state transitions, recovery, and listing.

Semantic public capabilities remain specific to their purpose. They construct a typed assignment and delegate actual process creation to one internal coordinator. Child capabilities write only to immutable scoped storage and assigned workspaces. Canonical reconciliation remains a main-session responsibility.

## Components and interfaces

### Product-partner prompt contracts

The always-loaded orchestrator contract defines stance and routing: seek the outcome behind a proposed solution, inspect facts independently, step back on material framing risk, challenge inherited product and technical premises constructively, stop discovery at the materiality boundary, and preserve user decision ownership.

The planning skill expands this into an adaptive discovery and delivery process for stories, changes, bugs, diagnostics, and incidents. It explicitly distinguishes mitigation, diagnosis, repair, and prevention. It plans delegation only when context isolation, specialist capability, independent evidence, or contribution size repays coordination overhead.

The plan critic checks goal-to-solution alignment, provenance of decisions, upstream product assumptions, material hidden cases, task coverage, delegation economics, dependency edges, integration boundaries, and verification credibility.

Behavioral scenarios evaluate observable decisions and tool use rather than prompt wording.

### Explorer assignment protocol

Add a typed exploration assignment:

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

A semantic `exploration_launch` capability validates this input, resolves the configured explorer model, creates the agent assignment, and invokes the shared coordinator. Direct code-understanding requests may use the same capability without creating a managed work item.

Explorer child capabilities:

```text
exploration_context
exploration_checkpoint
exploration_blocked
exploration_complete
```

`exploration_context` returns the immutable assignment and scoped output locations. `exploration_complete` accepts mode-sensitive structured output. Deterministic validation enforces common evidence requirements plus mode-specific fields. One configured protocol nudge may start another process attempt under the same logical agent identity; persistent invalid output ends as protocol failure.

### Session identity

Read the stable UUID from Pi's session header and bind it to the repository identity. Session-private state lives under:

```text
~/.pi/agent/harness/repositories/<repo-id>/sessions/<session-id>/
```

Ephemeral or unavailable session identity fails closed for child launching unless Pi exposes another stable session identifier. `/reload` and continuation of the same session reuse the registry. New and forked sessions create distinct registries.

### SessionAgentRegistry

The registry is the authoritative snapshot for logical child identities and current lifecycle state. An ordered event file records transitions for observability and future TUI updates.

```text
sessions/<session-id>/
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

A logical agent record contains:

```ts
interface SessionAgentRecord {
  schemaVersion: 1;
  id: string;
  sessionId: string;
  parentAgentId: string;
  depth: 1;
  role: string;
  state: AgentState;
  provider: string;
  model: string;
  effort: string;
  workItemId?: string;
  taskId?: string;
  evaluationId?: string;
  runId?: string;
  workspace?: string;
  currentAttemptId?: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  error?: string;
}
```

No separate `kind` field is stored; role is authoritative for behavioral and display classification. Scope references support navigation without duplicating role semantics.

### Atomic registry transactions

A session-scoped cross-process mutex serializes registry operations. Each transaction:

1. Acquires the lock with owner identity and stale-owner recovery metadata.
2. Reads and validates the snapshot and current revision.
3. Validates the requested state transition, credential, depth, and slot count.
4. Applies the update and increments snapshot revision and event sequence.
5. Atomically replaces the snapshot.
6. Appends the corresponding sequenced lifecycle event.
7. Releases the lock.

The snapshot is authoritative. A missing event after a crash is repaired by reconciliation with a synthetic recovery event. Idempotency keys prevent replay from reserving another slot or finalizing twice.

### Agent states and slot accounting

Proposed logical states:

```text
reserved
launching
running
waiting_model
waiting_capacity
waiting_decision
blocked
paused
interrupted
recovery_required
reported
completed
failed
protocol_failed
cancelled
```

States through `reported`, excluding terminal failure and completion, occupy one of the 16 active slots because they remain unresolved work owned by the main session. `reported` retains a slot until the main session validates and reconciles the handoff; this prevents unlimited unprocessed completions from accumulating invisibly.

Terminal states releasing a slot:

```text
completed
failed
protocol_failed
cancelled
```

The exact allowed transition table is defined centrally and tested exhaustively. State changes cannot be made by arbitrary file edits without failing registry validation on the next read.

### LaunchCoordinator

All model-backed launch paths call one internal coordinator:

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

The coordinator atomically reserves an active slot and creates the assignment before invoking a child. It rejects depth greater than one and active count greater than sixteen before process creation. Spawn failure transitions the durable record to failed rather than deleting it.

Semantic wrappers include `agent_run`, `exploration_launch`, `task_launch`, `evaluation_launch`, and repair launch. Existing behavior remains available while direct-agent and supervised-task process mechanics converge behind the coordinator.

### File-backed process attempts

Each process attempt has a random immutable attempt ID and scoped credential. The child receives root session, logical agent, parent, depth, attempt, and run scope through protected environment variables.

Children are spawned in an independent process group with output directed to attempt files. They never require a writable parent pipe. While the main process is active, it tails files or consumes registry events for progress callbacks. The same files support later TUI rendering.

A child heartbeat contains attempt ID, PID, start metadata, and timestamp. PID is never accepted alone as process identity. Child capability calls validate assignment, attempt, credential, and allowed state before writing.

Protocol nudge or crash recovery creates another attempt under the same logical agent. A different assignment creates a new logical agent.

### Asynchronous messages

Messages are immutable records with later status transitions:

```ts
interface AgentMessage {
  schemaVersion: 1;
  id: string;
  agentId: string;
  assignmentId: string;
  type: "decision_report" | "change_request" | "blocked";
  status: "open" | "acknowledged" | "answered" | "closed";
  blocking: boolean;
  summary: string;
  rationale: string;
  evidence: Array<{ source: string; observation: string }>;
  options?: string[];
  recommendation?: string;
  checkpointPath?: string;
  createdAt: string;
  updatedAt: string;
}
```

Decision reports are non-blocking and remain linked to the terminal handoff. Change requests checkpoint safe work, transition to waiting_decision, and exit. Blockers checkpoint and exit. Main-session absence does not alter persistence behavior.

An orchestrator capability responds by stable message ID, records the answer, and permits a later attempt to receive original assignment, current authoritative context, checkpoint, message, and response. A response cannot directly alter canonical artifacts or revive stale approved planning.

### Handoffs and reconciliation

Every child role gains a typed terminal or recoverable handoff. A child that finishes writes the handoff atomically and transitions to `reported`; it does not perform canonical finalization.

At session startup and before dependent lifecycle mutations, reconciliation handles each unresolved agent idempotently:

1. Validate pending messages and terminal handoff first.
2. If a valid handoff exists, perform role-specific validation and canonical finalization, then mark completed.
3. If the positively identified process remains alive, preserve running state and resume file observation.
4. If the process is confirmed dead without handoff, mark interrupted and retain workspace, checkpoint, messages, and transcript.
5. If process identity is ambiguous, mark recovery_required and prevent a duplicate writer.
6. Surface open blocking messages before launching dependent work.

Task handoff validation preserves existing Git, clean-worktree, planning-revision, commit, and canonical-artifact checks. Evaluator validation preserves evidence and finding requirements. Explorer validation enforces its mode contract.

### Explicit control

`agent_control` operates on logical agent IDs and supports status-appropriate pause, resume, stop, and response actions. Stop targets only a positively identified process group, records stopping intent atomically, preserves files, and transitions deterministically. Session shutdown itself does not stop children.

A future dashboard reads the registry and event stream but is not part of this change.

## Data and control flow

```text
User and main orchestrator
        │
        ├─ collaborative discovery and repository questions
        │                 │
        │                 └─ exploration_launch
        │
        └─ semantic launch capability
                          │
                          ▼
                 LaunchCoordinator
                          │
              atomic reserve/register
                          │
                          ▼
                 child Pi process
                          │
             files + registry transactions
                 ┌────────┼──────────┐
                 ▼        ▼          ▼
             progress   message    handoff
                 │        │          │
                 └────────┴──────────┘
                          │
                  main live or resumed
                          │
                    reconciliation
                          │
                  canonical transition
```

## Failure and recovery

- Registry lock owner dies: recover only after process-owner validation and timeout; never remove a live owner's lock.
- Crash between reservation and spawn: stale `reserved` or `launching` record becomes failed or interrupted during reconciliation and releases its slot.
- Crash between snapshot and event append: snapshot remains authoritative; reconciliation appends a synthetic event.
- Main process exits: child continues file-backed execution; no canonical authority is transferred.
- Child exits after handoff: resume validates and finalizes it.
- Child exits before handoff: preserve partial state as interrupted.
- PID reuse or stale heartbeat: mark recovery_required rather than killing or duplicating.
- Planning revision changes: child may checkpoint and message, but terminal contribution validation fails stale context and requires orchestrator reconciliation.
- Message write succeeds while main is absent: the request remains open and is surfaced on resume.
- Output disk write fails: child reports the storage failure in stderr where possible and cannot claim valid completion without the structured handoff.

## Security and privacy

Registry, transcripts, process output, credentials, messages, and checkpoints remain under the repository-private harness root with restrictive permissions. Credentials are stored only as hashes in durable records. Child environment credentials are scoped to one attempt and assignment. Children cannot call launch coordination or canonical artifact tools. No transcript or private registry file is committed.

## Compatibility and migration

Existing work-item run records remain readable and recoverable. New launches create session-agent records and may retain links to legacy run IDs. Migration is additive: old runs are not moved, renamed, or deleted automatically. Existing public tool names remain available while their process implementation is routed through the coordinator. Configuration adds defaults for `maxActiveSubagentsPerSession: 16` and `maxSubagentDepth: 1`; existing repositories receive defaults without requiring immediate policy edits.

## Verification boundaries

- Prompt behavioral evaluation covers feature framing, product-foot-gun challenge, low-risk proportionality, bug diagnosis, and delegation restraint.
- Unit tests cover assignment schemas, mode-specific explorer completion, registry transitions, depth and slot limits, credentials, message transitions, lock recovery, and idempotent replay.
- Process integration tests cover concurrent slot reservation, file-backed child completion after parent exit, explicit stop, process-attempt retry, stale PID ambiguity, and session resume reconciliation.
- Managed lifecycle regression tests cover tasks, evaluations, repair, direct specialists, approval, integration, and completion.
- A final E2E starts explorer and task children, exits the main process, allows handoff and a blocking request, resumes the same Pi session, responds, reconciles, evaluates, and completes.

## Alternatives considered

### Separate registries for tasks, evaluations, and direct agents

Rejected because lifecycle accounting, depth enforcement, active limits, recovery, and future TUI aggregation would remain inconsistent.

### One generic model-facing launch tool

Rejected as the only public surface because it would erase useful typed semantic contracts. A generic internal coordinator with semantic wrappers provides consistency without weakening model guidance.

### Separate diagnostic agent role

Deferred. Explorer modes are evaluated first. A dedicated diagnostic role is justified only if tool needs or behavioral evaluation show that one explorer contract cannot maintain both fast reconnaissance and scientific diagnosis.

### Stop children whenever the main session exits

Rejected because assignments and handoffs are intentionally isolated and file-backed; automatic termination would discard useful work and weaken recovery.

### Preserve live pipe attachment across resume

Rejected because OS pipe and in-memory callback reattachment is unreliable. Durable files and reconciliation are authoritative instead.

## Open design questions

- Whether `reported` should consume an active slot until canonical reconciliation or release it immediately while remaining prominently pending.
- Exact heartbeat cadence and cross-platform process-start fingerprint implementation.
- Whether waiting-capacity agents should remain active indefinitely or transition to an explicit dormant state after a configurable interval.
