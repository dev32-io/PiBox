# Product-partner orchestration and durable subagent lifecycle

## Context

PiBox must help a user and developer identify and deliver the right technical outcome, not merely elaborate the first requested solution. The same orchestration surface supports stories, changes, bug fixes, diagnostic investigations, and direct code-understanding questions. Model-backed specialists run as separate Pi processes and communicate through capability-scoped files, but their launch paths and lifecycle records are not yet unified.

## Required behaviors

### Collaborative product and technical discovery

- The orchestrator distinguishes the desired outcome, affected actors, triggering situations, current behavior or workaround, material friction, success signals, guardrails, and proposed solution.
- A requested feature, UI flow, product rule, schema, API, or inherited technical design is treated as evidence of a prior decision rather than an immutable requirement.
- The orchestrator performs a step back when the proposed solution lacks a clear outcome, preserves contradictory guarantees, causes disproportionate complexity, creates repeated exceptional states, or conflicts with repository evidence.
- Step-back discussion connects the upstream premise to its engineering or user consequences, offers credible alternatives including a smaller or no-build path where appropriate, and gives a reasoned recommendation without taking decision ownership from the user.
- The orchestrator finds repository and external facts itself, clearly separates stated, observed, inferred, recommended, delegated, and unresolved information, and puts only consequential decisions to the user.
- Discovery depth is adaptive and conversational rather than presented as a formal mode. One pivotal question is preferred when it can reframe the story; a concise frontier may contain multiple independent questions.
- Discovery stops when additional answers would not materially change the outcome, scope, architecture, domain or interaction contract, delivery topology, verification, rollout, or recovery.
- Hidden cases are probed through material scenarios such as first use, repeated use, empty or invalid states, interruption, concurrency, identity, lifecycle, permissions, dependency failure, migration, rollback, operations, abuse, and accessibility. The orchestrator does not manufacture scope from low-impact possibilities.
- For bugs, the orchestrator distinguishes implementation defects, component-contract defects, interaction defects, product-policy defects, domain-modeling defects, and outcome mismatch. A confirmed upstream product foot gun returns the conversation to discovery before repair planning.
- For active incidents, safe mitigation may precede complete root-cause diagnosis, while evidence preservation, diagnosis, repair, and prevention remain distinct.

### Proportionate technical planning

- Planning starts only after user and orchestrator share an understanding and the user asks for a canonical draft or delegates the remaining choices.
- Task boundaries balance context size, delegation overhead, role or model needs, independent evidence value, dependency structure, integration risk, and delivery urgency.
- Delegation and parallel execution are optional techniques, not plan-quality metrics. Small coupled work stays together when delegation overhead would dominate.
- Contributions use coherent vertical or tracer-bullet boundaries where practical, declare only genuine blockers and resource conflicts, and identify the smallest meaningful integration and proof boundaries.
- High-impact uncertainty may produce an exploration, experiment, or diagnostic contribution before a repair or implementation is claimed.
- The drafted contract remains conversationally refinable. A coherent revision is submitted and presented with the alternatives to refine it naturally or approve it through the direct harness command; no readiness passphrase is required.

### Explorer assignment and completion

- The existing explorer role supports `lookup`, `map`, `trace`, `impact`, `diagnose`, and `explain` modes without choosing product direction or mutating files.
- Every exploration launch supplies a typed assignment containing mode, question, decision supported, known evidence, starting scope, depth, stop conditions, and required output.
- Explorer depth supports quick, standard, and thorough investigation; the selected depth controls breadth without weakening citation requirements.
- Mode-sensitive completion records a direct answer, observed system, precise path or symbol evidence, relevant behavior or data flow, working comparisons, hypotheses with supporting and conflicting evidence, change implications, material hidden cases, and remaining unknowns or the cheapest next probe as applicable.
- Diagnostic exploration records expected and observed behavior, reproduction status, recent relevant changes, failure boundary, competing hypotheses, and discriminating evidence. It separates proximate technical cause from upstream enabling product or design conditions.
- Explain mode produces a concise mental model, evidence-backed execution path, important exceptions, uncertainty, and useful next reading without requiring managed planning.
- Missing required mode output receives a bounded protocol nudge. Persistently invalid completion becomes a visible protocol failure rather than generic prose being accepted.

### Unified session agent registry

- Every model-backed direct child launch passes through one internal launch coordinator while semantic public tools remain available for exploration, direct specialists, tasks, evaluations, and repairs.
- The registry is private, keyed by repository identity and the stable UUID of the main Pi session, and shared by all launch paths for that session.
- The main agent has depth zero. Every direct child has a stable agent ID, the main agent as parent, and depth one. A child cannot launch another child, and every depth-two request fails before reservation or process creation.
- At most 16 agents may simultaneously occupy active states for one main session. Slot reservation and lifecycle registration are one cross-process atomic transaction; a seventeenth request fails before process creation.
- Agent records use role as the display and behavioral classification and retain model, effort, parent, depth, relevant work item or task or evaluation references, workspace, run identity, process attempts, timestamps, state, summary, error, transcript location, and handoff location.
- Registry snapshots and ordered lifecycle events use a private cross-process mutex, revision checks, atomic replacement, stale-owner recovery, and deterministic state-transition validation.
- Completed, failed, protocol-failed, and cancelled records remain available for history and future TUI presentation but release their active slot. Waiting, paused, interrupted, and recovery-required assignments remain visible as active until reconciled or cancelled.
- A new process attempt for the same assignment remains under the same logical agent identity. A distinct assignment receives a distinct identity.

### File-backed background execution

- Child Pi processes run independently of the main process and do not rely on parent-owned stdout or stderr pipes, in-memory callbacks, or synchronous main-session RPC.
- Child stdout, stderr, transcript events, lifecycle events, checkpoints, messages, and terminal handoffs are written to scoped private files. While present, the main process may tail those same files for updates.
- Exiting, reloading, or losing the main Pi process does not automatically terminate active children. Explicit stop controls remain available.
- Child credentials authorize only their immutable assignment scope, private records, structured messages and handoffs, and assigned workspace. They cannot mutate canonical artifacts or spawn another agent.
- The registry associates each process attempt with a random attempt ID, PID, start information, heartbeat, and assignment identity. A PID alone never proves process identity.

### Asynchronous worker-orchestrator messages

- Decision reports are durable, non-blocking notifications that a worker may attach to its final handoff after continuing within delegated scope.
- Change requests are durable blocking messages when the approved contract must change. The worker checkpoints safe partial work, transitions to waiting for a decision, and exits instead of consuming a model invocation while idle.
- Blocker reports checkpoint work, record evidence and options, enter a recoverable blocked state, and exit cleanly.
- Main-session absence never causes message submission to fail solely because no live orchestrator process exists.
- Messages have stable IDs, agent and assignment references, status, blocking semantics, summary, rationale, evidence, options, recommendation where present, checkpoint linkage, and timestamps.
- The orchestrator can write a durable response linked to an open message. Resumption starts a new process attempt with the original assignment, current authoritative artifacts, retained workspace, checkpoint, request, and response.
- Worker-proposed changes never mutate or supersede canonical planning automatically.

### Resume and reconciliation

- Resuming the same Pi session reopens the same registry using the session-header UUID rather than the previous process PID.
- For every previously active agent, reconciliation first checks durable messages and handoffs, then positively identified process liveness.
- A valid terminal handoff from an exited child is validated and finalized even though the original in-memory supervisor is gone.
- A positively identified live child remains running and is observed by tailing its files; no duplicate process is launched into its workspace.
- A confirmed-dead child without a valid handoff becomes interrupted with its workspace, checkpoint, transcript, and messages preserved for recovery.
- Ambiguous process identity becomes recovery-required and blocks duplicate launch until resolved.
- Pending blocking messages are surfaced to the resumed orchestrator before dependent execution continues.
- Reconciliation is idempotent and cannot double-finalize a handoff, duplicate canonical transitions, over-count active slots, or erase historical records.

## Acceptance criteria

- **AC-001:** In repeated fresh-context scenarios, a solution-heavy request with an unclear outcome causes the orchestrator to inspect available facts, explain a material step back, and collaboratively recover the goal before writing canonical artifacts.
- **AC-002:** In repeated scenarios where an inherited UI, product rule, or domain premise creates disproportionate technical complexity, the orchestrator surfaces the upstream assumption, compares credible paths, and recommends reconsideration without silently changing scope.
- **AC-003:** Clear low-risk work proceeds with proportionate clarification, while additional low-impact questions do not prolong discovery or inflate scope.
- **AC-004:** Bug and diagnostic scenarios distinguish symptoms, proximate technical causes, upstream enabling conditions, mitigation, repair, and prevention before claiming a fix plan.
- **AC-005:** Planning scenarios produce sensible contribution boundaries based on context and coordination economics; they neither force delegation nor manufacture parallel tasks to improve a metric.
- **AC-006:** Explorer launch rejects missing typed assignment fields and supports lookup, map, trace, impact, diagnose, and explain modes with quick, standard, and thorough depth.
- **AC-007:** Explorer completion rejects missing mode-required evidence after the configured protocol nudge and records a stable structured handoff with precise repository citations.
- **AC-008:** All direct specialists, explorers, tasks, evaluators, and repair workers reserve and update one session registry before process creation, and their lifecycle can be listed from that registry.
- **AC-009:** With 16 active agents, a seventeenth launch fails atomically without spawning a process or creating a partial assignment; concurrent reservations cannot exceed the limit.
- **AC-010:** A child launch request at depth one fails before reservation, leaving the registry and process table unchanged.
- **AC-011:** Main-process exit leaves file-backed children running; a child can checkpoint, send a message, and write a terminal handoff without a live main process.
- **AC-012:** Resuming the same Pi session identifies its prior registry and correctly reconciles live, reported, interrupted, and identity-ambiguous children without duplicate writers.
- **AC-013:** A blocking change request written while the main session is absent is surfaced on resume, preserves safe partial work, and can receive a durable response consumed by a later process attempt.
- **AC-014:** Non-blocking decision reports remain linked to the assignment and terminal handoff without pausing safe in-scope execution.
- **AC-015:** Registry snapshot replacement, event sequencing, state transitions, slot accounting, stale-lock recovery, handoff finalization, and replay are deterministic under concurrent and interrupted operations.
- **AC-016:** Existing managed lifecycle tests, approval gates, worktree recovery, schema-v1 compatibility, and canonical artifact protections continue to pass.

## Out of scope

- Final fleet dashboard, status panel, or management dialog.
- Nested delegation beyond direct children.
- Remote or cross-machine agents.
- Preserving an LLM provider's in-memory context after process exit.
- Automatically editing canonical artifacts from explorer or worker messages.
- Redesigning Pi's shutdown lifecycle to add a cancellable pre-quit event.
