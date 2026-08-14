# PiBox Managed Workflow Design Specification

**Status:** Implemented v1
**Date:** 2026-08-10  
**Scope:** Full research, planning, execution, integration, evaluation, and recovery workflow

## 1. Purpose

PiBox will provide a capability-backed managed development workflow for Pi. It will help a persistent main Pi session research work, turn understood intent into durable specifications and designs, plan an executable task graph, delegate isolated work to specialized agents, evaluate the results, integrate reviewed changes, and recover from interruptions.

The harness is not intended to replace a capable model with a rigid workflow engine. Its central design principle is:

> Models decide semantic work; capabilities enforce mechanical truth.

The main Pi session remains the user's conversational and orchestration authority because it is where user intent, corrections, and decisions enter the system. Child agents advise or contribute bounded work; they do not own process decisions. The extension provides reliable artifacts, lifecycle state, model routing, worktree isolation, role contracts, completion protocols, evaluation gates, and recovery controls.

The workflow scales with the work. A small text or color edit can remain ordinary ad-hoc Pi work. A bounded change can use lightweight artifacts and selective delegation. A complex story can use the complete planning, review, execution, and evaluation workflow.

The workflow defines phase-level obligations, not a mandatory per-task ceremony. Planning must establish a reviewed contract; implementation must produce an assembled result; completion must have proportionate evidence. The orchestrator decides whether review and testing happen per task, once for an integration unit, once for the completed work item, or are unnecessary for a low-risk contribution. This explicitly avoids forcing every task through the same implement-review-test-fix loop.

## 2. Design goals

1. Preserve the authority, capability, and flexibility of the main Pi session.
2. Support a complete workflow from research and brainstorming through proportionate integrated evaluation.
3. Treat workflow stages as phase-level requirements rather than a uniform per-task pipeline.
4. Let the orchestrator skip, defer, batch, or combine ceremony according to risk and when the result becomes meaningfully testable.
5. Make filesystem artifacts the durable source of intent, design, task context, decisions, evidence, and outcomes.
6. Keep raw operational history private and outside Git and all worktrees.
7. Make subagent definitions independently configurable, measurable, and improvable.
8. Use deterministic capabilities for state transitions, paths, Git operations, model resolution, completion handoffs, and integration.
9. Support safe concurrent work in isolated Git worktrees.
10. Fail loudly rather than hide dirty branches, stale plans, missing handoffs, invalid evidence, or integration conflicts.
11. Recover gracefully from provider failures, subscription limits, process interruption, and model unavailability.
12. Keep artifacts tool-neutral and indexable for a later dashboard.
13. Avoid Pi upstream modifications and dependencies on terminal-specific layout APIs.
14. Leave room for later sandboxing without redesigning the agent-facing capability API.

## 3. Non-goals and deferred work

The first version will not provide:

- OS-level filesystem, network, or process sandboxing.
- Automatic delayed resumption after subscription limits reset.
- Seamless migration of an active streaming provider request.
- A full-screen subagent sidebar or web dashboard.
- Nested delegation by ordinary worker agents.
- Cross-repository stories or distributed workers.
- Automatic deletion of private history, branches, or worktrees.
- A replacement for normal ad-hoc Pi usage.

Deferred work is tracked in [`../../todo-harness.md`](../../todo-harness.md).

## 4. Core concepts

### 4.1 Main session

The user's normal Pi session is the persistent orchestrator. Research, chat, planning, execution control, evaluation triage, and user decisions all remain in this session.

The main session may:

- Edit directly for small work.
- Call any specialist agent definition directly.
- Start or promote a managed change or story.
- Create and amend canonical artifacts through capabilities.
- Schedule, steer, pause, restart, and stop child agents.
- Judge context impact, task complexity, concurrency, findings, and repair strategy.
- Integrate reviewed task work.
- Escalate only critical decisions that exceed its authority.

### 4.2 Work levels

The planner exercises judgment rather than applying a file-count rule:

```text
ad hoc
  Tiny, local, reversible work.
  Direct implementation and optional role calls.
  No committed harness artifact is required.

change
  A bounded outcome, usually one or a few tasks.
  Lightweight intent/spec/design artifacts and selective delegation.

story
  Multiple concerns, dependencies, risks, or concurrent tasks.
  Full planning, review, orchestration, and evaluation.
```

Relevant complexity signals include ambiguity, reversibility, cross-cutting contracts, security or data impact, dependency structure, concurrency opportunity, and verification burden.

The user can override the planner's classification at any time. Ad-hoc work can be promoted into a change if it grows.

### 4.3 Work-item kinds

Managed work initially supports one extensible schema with:

```text
kind: change | story
```

A change is small and surgical. A story is broader and normally contains multiple tasks. Additional kinds may be introduced later without replacing the common schema.

### 4.4 Canonical and operational state

The harness separates two planes:

```text
Committed project artifacts
  Intent, specs, design, decisions, task contracts,
  curated evaluations, evidence, and outcomes.

Ignored repository-local operational state (`.pibox/`)
  Runs, transcripts, events, locks, heartbeats,
  raw command output, checkpoints, and recovery data.
```

The orchestrator feature branch is the canonical project source. Private state is not a substitute for committed contracts, and committed artifacts do not contain raw execution history.

## 5. Architecture

### 5.1 Overall topology

```text
MAIN PI SESSION — ORCHESTRATOR
│
├── Research and clarification
│   └── explorer agents
│
├── Planning
│   ├── Superpowers-style brainstorming
│   ├── canonical artifact capabilities
│   └── independent plan critic
│
├── Execution
│   ├── task scheduler
│   ├── isolated implementers
│   ├── context and control inboxes
│   └── serialized integration
│
└── Evaluation
    ├── deterministic gates
    ├── code reviewers
    ├── repair implementers
    └── E2E testers and evidence collectors
```

### 5.2 Extension components

```text
Harness extension
├── Configuration and model resolver
├── Artifact registry
├── Work-item state machine
├── Agent-definition and prompt registry
├── Subagent supervisor
├── Scheduler and control inbox
├── Git/worktree manager
├── Evaluation coordinator
├── Lifecycle and failure classifier
└── Private event/run store
```

Components expose typed operations rather than allowing prompts to invent state paths or Git procedures.

### 5.3 Child process topology

The initial runtime will use supervised Pi child processes with structured event output. Each child starts with:

- A fixed working directory.
- An exact role prompt and skill set.
- A resolved provider, model, and effort level.
- A role-specific tool and capability set.
- An immutable run identity.
- A cancellation signal owned by the supervisor.

Every model-backed child is reserved in one private registry keyed by the stable main Pi session ID. The main agent is depth zero and direct children depth one; recursive launching fails mechanically. A session may own at most sixteen nonterminal logical children, and each retains its slot across process attempts, waits, pauses, blockers, reporting, and recovery.

Children run in independent process groups and write stdout, stderr, transcript events, heartbeat, checkpoints, asynchronous messages, and handoffs directly to private files. They may continue after the main Pi process exits. Resuming the same session reconciles handoffs before liveness, preserves positively identified live processes, marks dead attempts without handoff interrupted, and treats stale-heartbeat PID ambiguity as recovery-required. The adapter boundary remains reusable by a future Pi SDK-backed runner.

## 6. Authority model

### 6.1 Orchestrator authority

The orchestrator may act autonomously while preserving the reviewed contract. This includes:

- Strengthening task isolation.
- Reordering eligible tasks.
- Adding dependency edges.
- Pausing, steering, restarting, or replacing agents.
- Resolving ordinary implementation details.
- Splitting oversized tasks without changing intent.
- Rejecting incomplete handoffs.
- Requesting additional evaluation.
- Applying non-semantic artifact corrections.
- Selecting or revising a task capability tier within reviewed scope.

### 6.2 Mandatory user escalation

The orchestrator pauses affected work and asks the user before it:

- Changes the work-item intent or desired outcome.
- Materially expands scope.
- Removes or weakens acceptance criteria.
- Contradicts an explicit user decision.
- Changes a security or privacy boundary.
- Performs destructive Git operations.
- Abandons a load-bearing task.
- Accepts a critical unresolved evaluation finding.

A critical decision produces a concise packet containing the finding, affected work, why user authority is required, available options, and the orchestrator's recommendation.

### 6.3 Enforcement boundary

The model judges semantics. The extension enforces mechanics:

| Orchestrator judgment | Extension enforcement |
|---|---|
| Classify ad-hoc/change/story | Validate schemas and supported kinds |
| Choose artifact dimensions | Create deterministic paths and indexes |
| Decompose and prioritize tasks | Validate dependency references and cycles |
| Recommend concurrency | Enforce worktrees, resource locks, and limits |
| Assign capability tier | Resolve an ordered same-tier `provider/model#effort` pair |
| Judge whether a finding is critical | Keep affected work paused while waiting |
| Choose repair strategy | Enforce retry bounds and lineage |
| Judge context impact | Require designated rereads and acknowledgements |
| Judge semantic completion | Require the declared completion proof |
| Choose when to skip, defer, batch, or combine checks | Enforce the orchestrator-declared verification plan |
| Choose integration order and integration units | Serialize and atomically apply integrations |

## 7. Managed workflow

### 7.1 Lifecycle

```text
Research and clarify
        ↓
Create intent, specifications, and design
        ↓
Generate task graph and evaluation plan
        ↓
Independent plan critique
        ↓
Explicit user request to run
        ↓
Execute eligible tasks
        ↓
Assemble task contributions into integration units
        ↓
Run evaluation at the planned meaningful boundary
        ↓
Repair when findings require it
        ↓
Outcome and completion
```

The workflow may move backward when a later finding exposes an earlier gap. Individual tasks do not have to traverse every phase independently. A story can defer build, review, or testing until several partial contributions have been assembled into something meaningful.

### 7.2 Work-item state

Phase and operational state remain separate:

```yaml
phase: planning       # planning | execution | evaluation | complete
state: active         # active | waiting_user | paused | blocked | failed | complete

planning:
  revision: 3
```

This avoids encoding combinations such as `execution-paused-for-user` into one unmaintainable enum.

### 7.3 Execution authorization

Research can flow naturally into planning and review. A clear user request to start or run the reviewed workflow is the sole execution gate. Planning, review, acknowledgement, a problem report, or a proposed fix does not itself authorize execution. No separate approval command or planning-status transition exists.

The deliverable contract covers intent, requirements, acceptance criteria, and binding user/architecture decisions. Execution mechanics—task boundaries, integration grouping, evaluator placement, and check timing—remain under orchestrator authority unless the user explicitly made one of them binding.

Revisions identify the exact planning context used by workers and evaluators. The harness relies on scoped tools, schema validation, serialization, revision checks, clean Git state, and immutable delivery history rather than approval metadata or contract hashes.

## 8. Canonical artifact model

### 8.1 Root and stable paths

All managed project artifacts live under the visible, tool-neutral root:

```text
agent-artifacts/
```

Completed work items are never moved to an archive directory. Status metadata represents lifecycle, preserving stable links and Git history.

### 8.2 Work-item structure

```text
agent-artifacts/<work-item-id>/
├── index.yaml
├── intent.md
├── specs/
│   └── <dimension>.md
├── design/
│   └── <dimension>.md
├── decisions/
│   └── <decision-id>.md
├── tasks/
│   └── <task-id>/
│       ├── task.yaml
│       ├── brief.md
│       └── acceptance.md
├── evaluations/
│   └── <evaluation-id>/
│       ├── evaluation.yaml
│       └── report.md
├── evidence/
│   └── <evaluation-id>/
│       ├── manifest.yaml
│       └── ...
└── outcome.md
```

The core categories are fixed. The planner chooses the number and names of dimensional spec and design documents. Empty optional directories are not required.

### 8.3 Work-item index

`index.yaml` is the machine-readable work-item record and artifact catalog:

```yaml
schemaVersion: 1

id: session-model-redesign
kind: story
title: Session Model Redesign

phase: execution
state: active

planning:
  revision: 3

artifacts:
  - id: intent
    type: intent
    path: intent.md
    status: draft

  - id: session-identity
    type: spec
    path: specs/session-identity.md
    status: draft
    tags: [sessions, security]

  - id: runtime-architecture
    type: design
    path: design/runtime-architecture.md
    status: draft
    tags: [runtime]

  - id: server-minted-session-ids
    type: decision
    path: decisions/server-minted-session-ids.md
    status: accepted

tasks:
  - id: session-metadata
    path: tasks/session-metadata/task.yaml

evaluations:
  - id: final-e2e
    path: evaluations/final-e2e/evaluation.yaml
```

The index catalogs identity and paths. Task and evaluation details live in their own manifests, avoiding duplicate status sources.

### 8.4 Task manifest

```yaml
schemaVersion: 1

id: session-metadata
title: Implement authoritative session metadata
status: ready

dependsOn: []
references:
  specs: [session-identity, permissions]
  designs: [runtime-architecture]
  decisions: [server-minted-session-ids]

execution:
  resourceClaims: [session-schema]
  assignment:
    agent: implementer
    tier: high
    rationale: Bounded but cross-cutting session lifecycle and concurrency reasoning

assembly:
  stageId: session-screen
  intermediateState: partial

verification:
  timing: integration-unit
  methods: [build, combined-spec-review, combined-quality-review]
  taskChecks: []
  rationale: This contribution is not independently runnable or useful.
```

`brief.md` contains bounded worker instructions and context. `acceptance.md` contains observable completion criteria and required evidence.

### 8.5 Evaluation and evidence manifests

```yaml
id: session-screen-combined-review
type: combined-review
scope:
  integrationUnit: session-screen
status: passed
required: true
attempt: 1
result:
  verdict: pass
  report: report.md
  evidence: ../../evidence/session-screen-combined-review/manifest.yaml
```

Evaluations may target a task, integration unit, or complete work item. Their presence is determined by the orchestrator's proportionate verification plan.

Evidence manifests record producing evaluation, canonical commit, environment, command or interaction, timestamp, result, paths, and checksums. A report cannot claim an absent evidence item.

### 8.6 Artifact mutation

Only the main orchestrator can mutate canonical artifacts through dedicated capabilities. Read capabilities use progressive disclosure: catalogs are compact cursor pages, one resource is a summary by default, and full content is retrieved through revision-pinned ranges or matching passages. Exact mutation schemas are loaded on demand rather than occupying every main-session prompt. Mutations:

1. Acquire the canonical lock.
2. Require a clean feature branch.
3. Validate IDs, types, references, and operation scope.
4. Write through temporary paths.
5. Validate the complete resulting schema.
6. Update indexes and informational revision metadata.
7. Commit the transaction.
8. Return a compact receipt containing the canonical commit, changed refs, and affected work-item revisions—not complete intermediate resources.

Multi-file transactions produce one canonical commit. Workers submit amendment and decision requests instead of editing `agent-artifacts/`.

## 9. Planning behavior

The collaboration lifecycle and enduring design principles are defined in [`../agent-collaboration-flow.md`](../agent-collaboration-flow.md). Prompt, skill, and workflow changes should preserve that flow.

### 9.1 Main-session skills

The orchestrator uses focused skills rather than one giant workflow prompt:

```text
product-discussion  → freeform exploration without canonical workflow pressure
shape-story         → high-level intent, specification, design, and decisions
plan-delivery       → technical tasks, stages, assignments, and verification
workflow-run        → explicitly requested execution, recovery, completion, and briefing
```

Each phase owns one primary deliverable and naturally offers the next phase. Prior authorization to plan carries across story shaping into delivery planning unless a material decision requires the user; execution requires a clear user request to run the reviewed workflow. These skills describe judgment and behavior. The extension provides the mechanical capabilities.

### 9.2 Research and brainstorming

Planning follows Superpowers-style behavior:

- Investigate the repository before proposing changes.
- Spawn explorers where they improve understanding.
- Ask one material question at a time.
- Compare meaningful approaches and trade-offs.
- Keep the user involved in product and architectural decisions.
- Exercise judgment on low-level structure rather than burdening the user.

Research agents return source-grounded reports. The main session synthesizes those reports into canonical planning artifacts.

### 9.3 Artifact dependency flow

```text
research
   ↓
intent
   ↓
spec dimensions
   ↓
design dimensions and decisions
   ↓
task graph
   ↓
evaluation and evidence plan
   ↓
plan critique
   ↓
user request to run
```

Dimensions represent independently understandable concerns, not arbitrary document-size splits.

### 9.4 Task planning requirements

Each task must be:

- A bounded authoritative context capsule for one implementer attempt.
- Focused on one dominant contribution concern and primary failure boundary.
- Grounded in explicit canonical artifact references and only its assigned acceptance criteria.
- Clear about whether it is a complete behavior or a partial contribution.
- Honest about dependencies and its expected intermediate state.
- Assigned to a stage when several tasks must be assembled before they are meaningful.
- Assigned to an ordered stage; blockers live in earlier stages and same-stage siblings are independent.
- Given a proportionate verification timing: task, integration-unit, work-item, or intentionally skipped.
- Assigned a capability tier only after decomposition.

The planner drafts tracer-bullet contributions rather than horizontal implementation layers. Each task cuts a narrow but complete path through the behavior, implementation layers, and focused tests it needs; is independently demoable or verifiable; and fits one fresh worker context. Setup belongs with the behavior that needs it. Preparatory seams and expand–migrate–contract sequences are exceptions used only when vertical slices cannot remain coherent or green.

The planner writes the complete draft atomically, reads the whole plan graph at the exact written revision back, and only then performs one lightweight self-review with fresh eyes: map each binding criterion and constraint to an owning task and proof, find vague placeholders, and verify dependencies, stages, references, and produced/consumed interfaces agree across the graph. If needed, it applies one revision-pinned surgical edit without rewriting unchanged resources and does not repeat the review. Planner-facing writes default harness-owned lifecycle and schema boilerplate, but task briefs and acceptance contracts remain structured because they are injected into implementation context. A stronger tier or deep deliberation never compensates for avoidable task scope.

Tasks in one execution stage are the parallel frontier. They cannot depend on one another and must have compatible resource claims. Blocked work belongs in a later stage. The extension derives execution mechanics from topology: singleton stages run directly on the feature branch; multi-task stages start isolated worktrees from one pinned base and cross one atomic merge-and-check barrier.

### 9.5 Optional plan critic

When the user explicitly requests an independent critique, a fresh plan-critic agent checks:

- Intent, spec, and design consistency.
- Missing edge cases.
- Ambiguous or unverifiable requirements.
- Task and acceptance coverage.
- Dependency correctness.
- False concurrency assumptions.
- Integration sequencing.
- Evaluation coverage.
- Model assignments.
- Security, privacy, migration, and operational risks.

The critic reports findings to the orchestrator. It cannot edit canonical artifacts or authorize execution for the user, and ordinary planning does not wait for a critic run.

## 10. Agent-definition system

### 10.1 Agent-definition contract

An agent definition is a generic configurable execution contract rather than a workflow-specific persona:

```yaml
agents:
  implementer:
    prompt: ../agent-definitions/implementer.md
    skills: [testing, implementation]
    tools: [read, grep, find, bash, edit, write]
    workspace: worktree
    canDelegate: false
    completionSchema: implementer-v1
    tier: medium
```

Each agent definition configures:

- Purpose and behavioral constraints.
- Prompt and skill set.
- Tool and capability allowlist.
- Workspace policy.
- Default capability tier.
- Delegation permission.
- Context policy.
- Structured completion schema.
- Canonical artifact identity.

### 10.2 Initial agent definitions

| Agent definition | Responsibility | Mutation authority |
|---|---|---|
| Explorer | Repository investigation and dependency mapping | None |
| Plan critic | Challenge planning artifacts and verification coverage | Findings only |
| Implementer | Implement one bounded task and its tests | Assigned worktree |
| Code reviewer | Compare implementation with requirements and review correctness, maintainability, regressions, and tests | None |
| E2E tester | Exercise integrated behavior and collect evidence | Runtime/test environment only |
| Repair implementer | Address accepted evaluator findings | Assigned repair worktree |

Reviewers do not silently fix the work they review. Product or test-infrastructure modifications require an implementer task, preserving evaluator independence.

### 10.3 Direct invocation

Agent definitions remain callable outside a managed workflow. For example:

> Run a code reviewer on my current edits with GPT-5.6 Sol at high effort.

Direct invocation does not require creating a work item. If the work later becomes managed, relevant findings may be promoted into canonical artifacts.

### 10.4 Prompt composition

A managed child launch has four bounded inputs:

```text
1. Generic agent-definition instructions — persistent system prompt
2. Workflow-only protocol prompt — persistent system prompt
3. Selected authoritative context — persistent system prompt
4. Assignment request — short user prompt
```

Direct user invocation omits the workflow protocol and canonical context. For implementation tasks, the persistent packet contains the self-contained task brief, acceptance contract, exact assigned specification criteria, explicitly referenced decisions, expected contribution state, and required checks. Reviewers receive scoped task manifests and contracts plus the full specification and design. Pi retains system prompts across compaction, and packets are rebuilt from canonical files for each process attempt.

### 10.5 Agent performance records

Private run records capture role and prompt versions, skills, requested and resolved model/effort, event traces, completion validation, evaluator outcomes, and repair lineage. This permits later empirical comparison without committing raw transcripts.

## 11. Context and communication

### 11.1 Filesystem-first context

Canonical Markdown and YAML files are the durable communication layer. Tool output and conversational memory are not the sole source of required context.

Implementers receive the context required for normal work without calling a tool. When a concrete uncertainty remains, `task_clarify` can list or read additional current resources from the surrounding story/change. Its normal use is one targeted read; it is not a startup step or a browsing loop.

The capability reads from the orchestrator feature branch, not the child's worktree copy. It can expose additional artifacts, sibling task contracts, integration units, and evaluation contracts.

### 11.2 Child communication capabilities

Workers communicate through:

```text
task_checkpoint
task_request_change
task_report_decision
task_blocked
task_complete
```

They do not choose private operational paths and cannot mutate canonical planning artifacts.

### 11.3 Live amendments

The orchestrator judges the impact of canonical changes.

For a small context-only clarification, the orchestrator sends a focused durable response. For a material contract or dependency change, it restarts the affected process attempt so the persistent packet is rebuilt from current canonical files. No context-version acknowledgement protocol is required.

A child cannot complete while a required context update is unacknowledged.

### 11.4 Checkpoints

Meaningful checkpoints contain completed work, commits, worktree cleanliness, acceptance progress, next steps, and risks. Checkpoints support interruption, model replacement, context refresh, and user-requested pause. They never substitute for terminal completion.

## 12. Model and effort routing

### 12.1 Configuration hierarchy

```text
Built-in defaults
    ↓
~/.pi/agent/harness/config.yaml
    ↓
<repository>/.pi/harness.yaml
    ↓
planned task assignment
    ↓
explicit spawn override
```

Repository configuration loads only after Pi project trust succeeds.

### 12.2 Capability tiers and model-specific effort

Plans choose one semantic capability tier rather than independently guessing model and reasoning effort:

```yaml
assignment:
  agent: implementer
  tier: high
  rationale: Complex pointer geometry with a settled contract
```

`medium` is the default for normal bounded engineering. Low is pure mechanical and low-risk; high is complex or broadly integrated; max is reserved for architecture, security, privacy, irreversible or high-blast-radius work, and exceptional ambiguity. A stronger tier never compensates for an oversized task.

Each tier is an ordered list of concrete `provider/model#effort` pairs:

```yaml
modelTiers:
  max:
    - openai-codex/gpt-5.6-sol#high
  high:
    - openai-codex/gpt-5.6-sol#medium
  medium:
    - openai-codex/gpt-5.6-luna#max
  low:
    - openai-codex/gpt-5.6-luna#medium
```

Supported concrete Pi effort levels remain:

```text
off | minimal | low | medium | high | xhigh | max
```

The runtime validates the configured level against the live model's actual `thinkingLevelMap`; it never clamps or silently reinterprets effort.

### 12.3 Resolution order

At spawn time:

1. Read the task's tier, or the agent-definition default for direct/evaluation work.
2. Apply an explicit user/main-session model and effort override for a free-form subagent when present.
3. Traverse the configured `provider/model#effort` pairs for the requested tier in order.
4. Filter against Pi's live registry, auth, scoped models, and exact effort support.
5. Record the requested tier, every attempted pair, and actual provider/model/effort.

Fallback is visible and remains inside the same capability tier. There is no automatic capability downgrade or effort clamping. Provider/auth/capacity recovery may resume on another valid same-tier pair; implementation or protocol failure does not by itself justify changing effort.

A strict override can prohibit fallback:

> Run the evaluator on GPT-5.6 Sol at high effort, strictly.

If no acceptable route exists, the run enters `waiting_model` rather than pretending to execute.

### 12.4 Main-session model selection

The planner and orchestrator may recommend or select a stronger active model when work complexity increases:

```yaml
orchestrator:
  modelSwitching: auto-visible   # off | suggest | auto-visible
```

A user-pinned model wins. Automatic selection is always visible.

### 12.5 Configuration merge and versioning

- Maps merge recursively by key.
- Scalars replace earlier values.
- Arrays replace rather than concatenate.
- Agent definitions may explicitly extend other agent definitions.
- Unknown security-critical fields fail closed.
- Diagnostics identify source file and property path.
- Every run records the effective configuration digest.

Model preference changes do not invalidate the reviewed semantic contract. The orchestrator may revise evaluator placement and check timing while preserving the deliverable contract and required final confidence. Broadening role authority, removing a user-mandated control, or weakening a binding security or acceptance obligation requires review.

## 13. Task scheduling and isolation

### 13.1 Tasks are contribution units

A task is a bounded unit of delegation and code ownership. It is not automatically a complete, independently runnable product increment and is not automatically an evaluation boundary.

```text
draft
  ↓
blocked / ready
  ↓
running
  ↓
contribution_complete
  ↓
staged in integration unit
  ↓
integrated
```

Optional states such as `reviewing` and `changes_requested` appear only when the orchestrator chooses task-level review. Exceptional terminal states include `failed`, `protocol_failed`, and `cancelled`.

A worker's structured handoff establishes that its assigned contribution is complete. The orchestrator decides whether to inspect it immediately, combine it with sibling work, or defer semantic verification until assembly.

### 13.2 Execution stages and integration units

Ordered execution stages are the scheduler topology. Each singleton stage executes directly on the feature branch; every multi-task stage is one parallel frontier whose tasks start from a pinned common base and cross an atomic merge barrier. Integration units remain semantic verification groupings and may span one or more stages.

The planner may group related tasks into an integration unit:

```yaml
integrationUnits:
  - id: new-screen
    tasks:
      - skeleton-layout
      - text-label-component
      - compose-screen
    intermediatePolicy: partial-allowed
    verification:
      timing: unit
      methods: [build, combined-spec-review, combined-quality-review]
```

An integration unit is the smallest assembled state that the planner expects to be coherent or meaningfully testable. It may contain one task or many.

This supports stories where isolated contributions are intentionally incomplete—for example, a skeleton without its components or generated code without its consumer. The planner does not waste evaluator runs proving that an intentionally partial task is not a complete screen.

### 13.3 Dependency semantics

The planner distinguishes:

- **Canonical dependency:** the prerequisite must already be integrated into the feature branch.
- **Integration-unit dependency:** a later task may start from the orchestrator-controlled staging base for its unit.
- **Assembly-only relationship:** independent task branches can run concurrently and are combined later.

Tasks cannot depend on another worker's uncontrolled worktree or uncommitted changes. Sequential tasks may build on a durable integration-unit staging commit owned by the orchestrator.

Resource claims protect shared external or generated resources that separate Git worktrees cannot isolate. Expected file paths are advisory only and never treated as proof of independence.

### 13.4 Scheduling

The reviewed stage graph determines concurrency and isolation. The extension launches one singleton-stage task at a time on the canonical feature branch, or all compatible ready tasks in a multi-task stage in isolated worktrees. The extension rejects launches when:

- The declared base or dependencies are not available.
- A required resource is locked.
- The main session already owns sixteen nonterminal logical subagents.
- The feature branch is dirty when a clean canonical operation is required.
- Worktree allocation fails.

### 13.5 Worktree allocation

Worktrees are allocated only for multi-task stages. Every sibling is based on the same pinned stage commit; a planner cannot request a worktree for a serial task or direct-repository execution for a parallel task.

```text
branch:
  harness/<work-item-id>/<task-id>

worktree:
  <canonical-repository>/.worktree/pibox/
    <work-item-id>/<task-id>
```

Allocation acquires a lock, verifies the selected base, records its exact commit, proves the repository-local target is ignored, checks branch/path ownership, creates or recovers the worktree, and launches the child with fixed `cwd`. Harness initialization creates Git only in an empty directory, ensures and checks out `develop`, idempotently appends effective `/.worktree/` and `/.pibox/` ignore rules, writes explicit repository policy including model-effort tier routes, and commits only harness-owned files. It refuses to stage an existing non-Git project implicitly. Repository-local operational state lives under `.pibox/`; global configuration and credentials remain under `~/.pi/agent/harness/`. Legacy external worktrees remain recoverable at their recorded runtime paths.

The harness never auto-stashes or auto-commits a dirty feature branch.

### 13.6 Worker completion requirements

An implementation task must finish with:

- A clean assigned workspace (feature branch for a singleton stage, worktree for a parallel stage).
- One or more contribution commits.
- A structured contribution summary.
- The checks the planner assigned to this task, which may be none.
- Explicit disclosure of expected failures or incomplete assembly state.
- No changes under `agent-artifacts/`.
- No unacknowledged context amendments.

A task is not required to claim full acceptance, pass the whole repository build, or run E2E when the reviewed execution strategy defers those obligations. The extension validates actual Git state and the declared handoff rather than imposing a universal test checklist.

## 14. Assembly and integration

### 14.1 Ownership

A singleton-stage child commits directly to the checked-out feature branch under the scheduler's exclusive feature-branch claim. Multi-task-stage children commit only to task branches. The orchestrator owns the canonical feature branch and atomic stage barrier. Reviewers inspect whichever boundary the orchestrator assigns: a task contribution, integrated stage/unit, or completed work-item candidate.

### 14.2 Parallel-stage merge barrier

```text
parallel task branches from one pinned base
    ↓
wait for every stage contribution
    ↓
merge in declared order on the canonical feature branch
    ↓
run the stage's declared checks
    ↓
publish all or reset the complete stage merge
```

No later stage observes a partially merged parallel batch. A failed merge or stage check resets the canonical branch to the pre-barrier commit while preserving task branches and worktrees for recovery. Integration units remain available as semantic review and evaluation boundaries over the assembled state.

### 14.3 Atomic canonical update

The canonical branch is updated only from an orchestrator-controlled candidate whose expected base still matches. If another unit integrates first, the candidate is rebuilt or rebased under orchestrator control.

The required checks are those declared for this integration boundary. The extension never invents a universal build/review/E2E gate.

### 14.4 Commit policy

The default commit boundary follows the meaningful integration unit, not necessarily an individual task:

```text
feat(screen): add composed session screen

Harness-Work-Item: session-screen
Harness-Integration-Unit: new-screen
Harness-Tasks: skeleton-layout, text-label-component, compose-screen
Source-Commits: abc1234, def5678, 987fedc
```

This keeps canonical history coherent when individual task contributions are intentionally partial. A single-task integration unit still produces a task-level commit. Repository policy may preserve a validated commit series explicitly.

### 14.5 Conflicts and incomplete assembly

Integration conflicts never trigger blind speculative resolution. The orchestrator may restart/rebase a contribution, launch an integration-repair agent, amend context, change assembly order, split or combine units, pause affected work, or escalate a critical semantic conflict.

The extension preserves the last clean canonical state and all task branches.

## 15. Proportionate evaluation and evidence

### 15.1 Phase-level obligation

Evaluation is required at the level necessary to establish confidence in the reviewed deliverable, not once per task. The planner and main orchestrator decide the cheapest meaningful verification boundary.

Possible boundaries are:

```text
task
integration-unit
work-item/final assembly
none for a low-risk contribution covered by a later boundary
```

For a new screen composed from skeleton, label, and composition tasks, the normal plan may be:

```text
no evaluator for skeleton
no evaluator for label
no E2E for either partial contribution
assemble the screen
run one combined spec/quality review
run only the tests or E2E journeys meaningful for the assembled screen
```

### 15.2 Verification plan

The planning artifacts describe coverage and timing:

```yaml
verification:
  - id: screen-build
    scope: integration-unit:new-screen
    methods: [build, targeted-tests]

  - id: screen-review
    scope: integration-unit:new-screen
    methods: [combined-spec-review, combined-quality-review]

  - id: screen-e2e
    scope: work-item
    methods: [e2e]
    when: user-visible-journey-exists
```

Each binding acceptance criterion must have a credible final verification story, but it need not map to a separate evaluator or test run. One combined evaluation can cover many criteria and tasks.

When requested, the plan critic challenges missing final confidence, not the absence of per-task ceremony.

### 15.3 Orchestrator discretion

The orchestrator may:

- Skip evaluation for trivial or purely structural contributions.
- Combine spec and quality concerns into one evaluator prompt when that is efficient.
- Batch review across several related tasks.
- Defer build or tests until all required pieces are assembled.
- Run targeted tests instead of the full suite.
- Omit E2E when there is no meaningful user journey or the risk does not justify it.
- Add stronger checks when implementation findings increase risk.

These changes do not require another user decision unless they weaken a user-mandated control, leave a binding acceptance criterion without credible proof, or alter a security/quality boundary the user explicitly required.

Child reviewers and evaluators can recommend additional checks, but the main orchestrator decides whether those checks become workflow requirements.

### 15.4 Available evaluation methods

Methods are composable tools, not mandatory stages:

1. **Deterministic checks:** build, types, targeted or full tests, lint, formatting, path restrictions, clean worktree, generated outputs, and repository commands.
2. **Specification review:** compare an assembled result against reviewed intent, requirements, design constraints, and acceptance criteria.
3. **Quality review:** assess correctness, edge cases, maintainability, regressions, security, error handling, and test quality.
4. **Integrated regression:** check interaction with the latest canonical base.
5. **E2E evaluation:** exercise a meaningful assembled user journey and collect evidence.

A planner may combine specification and quality review into one run. Independent agent definitions remain available when risk warrants separation.

### 15.5 Evaluator independence

When an evaluator is used, it runs in a fresh session and receives the reviewed artifacts, the assigned task/unit/work-item diff, structured handoffs, and evidence manifests. It does not receive implementer raw transcripts or private reasoning.

### 15.6 Findings

```yaml
id: SPEC-001
severity: high
status: open
criterion: session-id-server-minted
location: src/session/store.ts:84
summary: Client-provided session IDs are still accepted
evidence:
  - command: npm test -- session-security
    result: failed
blocking: true
```

The orchestrator triages findings as `accepted`, `rejected`, `duplicate`, `deferred`, or `needs_user`. Rejection requires rationale. Deferring a blocking binding criterion requires an explicit user decision.

### 15.7 Repair loop

A repair loop exists only when an evaluation boundary produces accepted findings:

```text
evaluation finding
       ↓
orchestrator triage
       ↓
accepted repair brief
       ↓
implementer or repair implementer
       ↓
proportionate recheck
```

The orchestrator may re-run only the affected check rather than repeat every evaluator and test. Default repair budgets apply per declared evaluation boundary, not automatically per task. The one protocol nudge remains separate.

Exhaustion never silently waives a blocking finding. The orchestrator replans, escalates model capability, accepts a justified non-blocking risk within its authority, or asks the user when required.

### 15.8 E2E integrity

E2E is reserved for meaningful assembled behavior, not scaffolding or isolated components with no runnable journey. When used, criterion states are:

```text
passed | failed | blocked | not_applicable
```

`blocked` requires evidence of attempted setup, the exact blocker, and why the next action cannot be driven. Inconvenience alone is not a blocker.

A passing verdict cannot reference absent evidence. The extension validates evidence paths and checksums.

### 15.9 Completion gate

A managed work item completes only when:

- Every required contribution is assembled or removed through a reviewed contract revision.
- The orchestrator has run the current verification plan at its declared boundaries.
- Binding acceptance criteria have proportionate final evidence or an explicit justified disposition.
- No accepted blocking finding remains.
- Canonical artifacts match the reviewed deliverable contract.
- The feature branch is clean.
- `outcome.md` records delivery, deviations, evidence, skipped/deferred checks, and remaining non-blocking risks.

## 16. Capability API

### 16.1 Orchestrator resource capabilities

```text
workflow_init
workflow_list
workflow_get
workflow_create
workflow_patch
workflow_delete
workflow_apply_change
workflow_transition
```

The resource API is authoritative for normal main-session planning. Earlier resource-specific create/define/update/submission tools remain registered as compatibility adapters but are hidden from the default orchestrator tool surface.

### 16.2 Execution capabilities

The separate workflow extension provides:

```text
workflow_start
workflow_control
subagent_spawn
subagent_status
subagent_control
subagent_respond
```

The workflow extension owns generic scheduling, lifecycle messages, and the progress widget. It discovers adapters through Pi's in-process event bus and never imports harness planning or artifact code. The harness adapter translates reviewed tasks, integration units, and evaluations into current workflow steps and performs their domain-specific execution.

`subagent_spawn` is the sole model-facing generic child launcher: it accepts a configured agent definition and task prompt, inventories validated built-in/configured/trusted-project definitions in its live description, defaults to background execution, and can wait in foreground mode when explicitly requested. Built-in and trusted `.pi/agents/*.md` definitions use conventional Pi frontmatter plus an optional PiBox capability `tier`; their `tools` field is the spawned child's base allowlist. Reserved selectors such as `pibox:task` and `pibox:evaluation` resolve through a central tool-group registry, and managed launches may add a group at runtime without duplicating its concrete capability names. Managed implementation tasks and evaluations are not launched through another model-facing tool; `workflow_start` and resume schedule their canonical steps internally, and adapters launch those children through the same coordinator and lifecycle registry. Repository exploration is ordinary delegation to the `explorer` definition. `evaluation_record`, `work_item_complete`, and `workflow_status` remain managed-workflow capabilities.

### 16.3 Worker capabilities

```text
task_clarify
task_checkpoint
task_request_change
task_report_decision
task_blocked
task_complete
```

### 16.4 Evaluator capabilities

```text
evaluation_context
evidence_record
finding_report
evaluation_checkpoint
evaluation_complete
```

### 16.5 Run-scoped identity

Every child capability binds to immutable repository, work item, task/evaluation, role, attempt, workspace, base commit, and planning revision identity. Model-supplied IDs cannot broaden that scope.

A supervised child receives an unguessable run credential. Future sandboxing can strengthen process boundaries without changing the capability contract.

### 16.6 Idempotency

Mutating calls carry an operation ID:

```text
same operation ID + same payload
  → return the prior result

same operation ID + different payload
  → reject
```

This prevents duplicate artifact commits, tasks, completions, evidence records, and integrations after retries or transport ambiguity.

### 16.7 Typed failures

Representative error codes include:

```text
DIRTY_CANONICAL_BRANCH
DEPENDENCY_NOT_INTEGRATED
MODEL_UNAVAILABLE
CAPABILITY_DENIED
CONTEXT_REFRESH_REQUIRED
INVALID_HANDOFF
RESOURCE_LOCKED
INTEGRATION_CONFLICT
EVIDENCE_MISSING
```

Prompts explain recovery behavior, but the typed code remains authoritative.

### 16.8 Completion protocol

Each role has a terminal schema. Prose-only completion is invalid. If a healthy child settles without a valid handoff, the harness sends one deterministic nudge. A second omission produces `PROTOCOL_FAILED`.

Capacity and infrastructure failures do not consume the protocol nudge or semantic repair budget.

## 17. Private control plane

### 17.1 Layout

```text
~/.pi/agent/harness/
├── repositories/
│   └── <repo-id>/
│       ├── repository.yaml
│       ├── locks/
│       └── work-items/
│           └── <work-item-id>/
│               ├── state.yaml
│               └── runs/
│                   └── <run-id>/
│                       ├── run.yaml
│                       ├── events.jsonl
│                       ├── transcript.jsonl
│                       ├── handoff.json
│                       ├── checkpoint.json
│                       └── commands/
```

Repository-owned task checkouts live separately at `<canonical-repository>/.worktree/pibox/<work-item-id>/<task-id>/`. Children interact through capabilities and do not choose operational paths.

### 17.2 Event log

Each run records append-only sequenced events. Mutable state files are projections. When projections disagree, the harness replays events and reconciles them with Git.

### 17.3 Locks

Locks protect repository integration, worktree allocation, canonical artifact mutation, resource claims, and per-task active ownership. Locks include owner, process identity, acquisition time, and heartbeat. Stale locks are diagnosed before removal.

### 17.4 Retention

Operational history is retained by default. The harness does not automatically delete transcripts, command output, branches, or worktrees. `/harness worktrees` inventories PiBox-owned worktrees, and `cleanupAll` removes only clean inactive ones; a dirty worktree requires an explicit named `--force` removal. Export and redaction commands remain deferred.

## 18. Lifecycle and recovery

### 18.1 Pi lifecycle hooks

The extension builds durable state from:

```text
session_start
before_agent_start
agent_start
message_start / message_update / message_end
turn_start / turn_end
tool_execution_start / update / end
after_provider_response
agent_end
agent_settled
session_shutdown
```

`agent_settled` is the terminal classification point because Pi may still retry, compact, or process queued continuations after `agent_end`.

### 18.2 Failure classes

```text
model_unavailable
rate_limited
subscription_exhausted
authentication_required
provider_unavailable
network_interrupted
context_overflow
tool_failed
agent_aborted
process_crashed
protocol_failed
unknown_provider_error
```

Structured HTTP status, headers, stop reasons, and process status take precedence over provider error-text matching.

### 18.3 Capacity handling

When a subscription or provider limit is detected:

1. Capture lifecycle evidence.
2. Allow Pi's built-in retry behavior to settle.
3. Save branch, checkpoint, and run state.
4. Mark the run `waiting_capacity`.
5. Stop new launches against the affected model/provider/account scope.
6. Notify the user without requiring a model response.
7. Wait for manual resume in v1.

Capacity interruption does not fail the task or consume repair/protocol budgets.

### 18.4 Fallback versus waiting

```text
Configured model missing
  → try ranked role fallbacks

Model-specific temporary limit
  → fallback when policy permits

Provider/account subscription exhausted
  → wait for user by default

No acceptable capability-ranked fallback
  → wait for user
```

Ambiguous limits conservatively wait rather than repeatedly consume requests.

### 18.5 Manual resume

```text
/workflow resume
/workflow resume <task-id>
/workflow resume --provider openai-codex
```

Resume rechecks model availability, resolves fallback policy, validates canonical and worker Git state, refreshes canonical context, and starts a fresh attempt from the existing branch/checkpoint.

Natural-language resume also works when the main provider is available.

### 18.6 Crash recovery

On startup or session resume, the harness:

1. Loads work-item and run projections.
2. Replays incomplete event logs.
3. Inspects branches and worktrees.
4. Detects dead child sessions.
5. Classifies runs as recoverable, interrupted, conflicting, or corrupt.
6. Presents recovery actions to the orchestrator.

It never resets branches, deletes worktrees, or discards uncommitted worker changes automatically. A dirty canonical feature branch always requires user resolution.

### 18.7 Workflow and subagent controls

```text
workflow_control(pause | resume | stop)
subagent_status
subagent_control(pause | stop)
subagent_respond
```

Workflow pause stops new scheduling while allowing current children to settle. Workflow stop terminates active children while preserving filesystem and private run state. Subagent pause or stop targets a positively identified logical child. Resume launches a fresh model session against the retained branch and durable response context when the adapter marks that step ready.

## 19. User experience

### 19.1 Natural-language first

The intended interface is ordinary conversation:

> Research and plan a story for replacing the session model.

> Start the reviewed session-model story.

> Run a code reviewer on my current changes using Sol at high effort.

> Pause the persistence task.

The orchestrator translates user intent into capabilities.

### 19.2 Deterministic commands

Commands remain available when a model is unavailable or exact control is preferred:

```text
/harness init [standard|economy]
/workflow status
/workflow agents
/workflow pause [task]
/workflow resume [task]
/workflow stop [task]
/workflow recover
```

### 19.3 V1 presentation

V1 uses inline tool rendering and a compact status indicator:

```text
Story: session-model-redesign
Phase: execution
Tasks: 4 integrated · 2 running · 1 ready · 1 blocked
Agents: 3 active
```

A full sidebar or dashboard is not required. The execution architecture remains independent of the eventual visual surface.

### 19.4 Notifications

The harness interrupts the user for:

- Plan ready for review.
- Critical decision required.
- Subscription/provider capacity wait.
- No acceptable model fallback.
- Dirty canonical branch.
- Integration conflict.
- Repair budget exhaustion.
- Work-item completion.

Routine successful transitions remain visible without demanding attention.

## 20. Safety and trust boundaries

### 20.1 V1 guarantees

The first version can deterministically enforce:

- Capability scoping.
- Canonical artifact ownership.
- Structured completion.
- Git/worktree allocation and validation.
- Branch/path diff checks.
- Model rank and effort policy.
- Planning revision and canonical context refresh.
- Locks, idempotency, and recovery records.

### 20.2 V1 limitation

Without OS-level sandboxing, an agent with `bash` may technically access paths beyond its assigned worktree. Tool allowlists and post-run checks reduce accidental violations but are not a security boundary against a malicious or prompt-injected process.

The capability API is intentionally designed so a later sandbox can enforce filesystem, network, process, and private-state boundaries without changing role contracts.

### 20.3 Trusted repository configuration

Repository role prompts, skills, and tool policies are executable agent configuration. The harness loads them only after Pi's project-trust mechanism accepts the repository.

## 21. Workflow verification strategy

The harness itself requires deterministic and model-assisted testing.

### 21.1 Unit tests

- Schema validation and migrations.
- Configuration merge semantics.
- Model and effort resolution.
- Capability authorization.
- State-machine transitions.
- Planning revision and explicit execution request.
- Idempotent mutation handling.
- Failure classification.
- Lock ownership and stale-lock diagnosis.

### 21.2 Git integration tests

Use temporary repositories to verify:

- Dirty feature branches fail loudly.
- Concurrent worktree allocation is collision-free.
- Workers cannot integrate canonical artifact changes.
- Canonical, integration-unit, and assembly-only dependencies use the correct controlled base.
- Integration-unit candidates preserve canonical cleanliness.
- Explicit partial intermediate states remain traceable and cannot accidentally satisfy final completion.
- Conflicts retain recoverable state.
- Unit-level squash commits retain source-task traceability.
- Interrupted worktrees can be reconciled safely.

### 21.3 Lifecycle fault injection

Recorded or synthetic event streams should cover:

- HTTP 429 with and without retry headers.
- Subscription exhaustion.
- Missing auth.
- Provider 5xx/network interruption.
- Context overflow and Pi compaction retry.
- Child process crash.
- Parent shutdown.
- Missing completion handoff.
- Duplicate capability calls after timeout.

### 21.4 Agent-definition and prompt evaluations

Agent behavior is evaluated separately from deterministic extension correctness. Versioned datasets should compare planner coverage, implementer protocol compliance, reviewer precision, false-positive rate, E2E drivability, model selection, and repair success.

Prompt scaffolding should be retained only when empirical results show it is load-bearing.

## 22. Implementation references

These projects and local materials informed the design and should be revisited during implementation. They are references, not runtime dependencies or sources to copy wholesale.

### 22.1 Pi and PiBox

- Installed Pi extension documentation, especially lifecycle hooks, custom tools, model registry/scoping, thinking levels, session events, and `agent_settled` semantics.
- Installed Pi `examples/extensions/subagent/index.ts` for supervised child invocation, structured JSON events, cancellation, model selection, usage collection, and error extraction.
- PiBox's existing extension structure and tests for package conventions and lifecycle-safe initialization.

The implementation must target public Pi extension/SDK APIs and must not patch upstream Pi internals.

### 22.2 Pikit

Repository: [adrianapan/pikit](https://github.com/adrianapan/pikit)

Useful references:

- `agent/extensions/subagents/index.ts`
- `agent/extensions/subagents/agents.ts`
- `agent/extensions/subagents/config.ts`
- `agent/extensions/subagents/types.ts`
- `agent/extensions/subagents/subagents.example.json`

Relevant lessons include role definitions, model-aware subagent configuration, supervised Pi subprocesses, structured output handling, and compact inline rendering. PiBox should retain its stronger capability scoping, durable handoffs, worktree isolation, and canonical artifact ownership rather than adopting prompt-only conventions.

### 22.3 pi-subagents

Repository: [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)

Useful references:

- `docs/agents.md`
- `docs/configuration.md`
- `docs/extension-api.md`
- `docs/models.md`
- `docs/observability.md`
- `docs/workflows.md`
- `src/extension/config.ts`
- `src/runs/shared/nested-render.ts`
- `src/runs/background/fleet-view.ts`
- `src/tui/fleet-status.ts`
- `src/tui/fleet.ts`

Relevant lessons include role files, model overrides, run observability, background/fleet concepts, and nested transcript presentation. Background execution, nested delegation, and a fleet UI remain deferred unless needed by the reviewed first implementation.

### 22.4 Agentic Dev Harness

Repository: [dev32-io/agentic-dev-harness](https://github.com/dev32-io/agentic-dev-harness)

Useful references:

- `docs/continuous-learning.md`
- `docs/ruleset-philosophy.md`
- `docs/workflow-and-skills.md`

Relevant lessons include keeping rules load-bearing, separating workflow skills, promoting proven learning deliberately, and periodically removing scaffolding that newer models no longer need.

### 22.5 Superpowers and skill references

- [obra/superpowers](https://github.com/obra/superpowers), especially brainstorming, writing plans, and subagent-driven development.
- [mattpocock/skills](https://github.com/mattpocock/skills), especially `to-spec`, `to-tickets`, `implement`, `code-review`, and `grill-with-docs`.
- [Agent Skills](https://agentskills.io/) for portable skill structure and progressive disclosure.

PiBox deliberately retains Superpowers' research-first planning discipline while removing its uniform per-task implementation/review/test ceremony. Skills should guide judgment; extension capabilities should enforce only mechanical truth and the orchestrator's chosen plan.

### 22.6 Artifact-system references

- [Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec), especially artifact dependencies, change organization, and spec-writing guidance.
- GitHub Spec Kit as a reference for staged specification and planning workflows.

PiBox uses a fixed core artifact structure with flexible dimensions rather than requiring users to adopt an external artifact engine.

### 22.7 Sentient repository

Local reference: `~/Development/sentient`

Relevant materials include architecture, agent rules, test knowledge, Superpowers plans/specs, evidence manifests, and session/skill-system designs. Its execution history provides concrete failure cases to test:

- Shared Git index/worktree collisions.
- False assumptions that tasks are disjoint.
- Non-bisectable intermediate commits.
- False-positive or ungrounded evidence.
- Agents declaring drivable E2E work blocked.
- Excessive repeated per-task review and testing.

The integration-unit and proportionate-verification design should be validated against realistic Sentient workflows such as a screen assembled from multiple partial component tasks.

## 23. Acceptance criteria for the initial harness

The design is successfully implemented when:

1. The main session remains the user-facing authority and can stay ad-hoc or create a managed change/story.
2. Managed planning produces indexed intent, specs, design, decisions, tasks, integration units, and proportionate verification coverage.
3. Execution begins only after a clear user request to run the reviewed workflow.
4. The planner can explicitly skip, defer, batch, or combine task-level review and testing while declaring the later meaningful verification boundary.
5. Partial task contributions can be assembled in orchestrator-controlled stages without pretending they are independently complete.
6. Agent definitions, tools, capability-tier routes, model-specific effort mappings, and same-tier fallback order can be set globally and overridden per repository.
7. The planner records one capability tier per task; the runtime resolves its ordered provider/model/effort pairs against Pi availability and exact thinking support.
8. Missing or unsupported pairs fall back visibly within the requested tier or enter a waiting state without silent downgrade or effort clamping.
9. Concurrent tasks run in deterministic isolated worktrees from a clean committed base.
10. Workers communicate through scoped capabilities and cannot own canonical artifacts or integration.
11. Completion requires a valid role-specific terminal handoff, with one deterministic nudge on omission.
12. The extension enforces the orchestrator-declared verification plan rather than a universal per-task pipeline.
13. Binding acceptance criteria receive proportionate final evidence, while meaningless task-level E2E is not required.
14. Integration occurs through controlled task/unit candidates and leaves the canonical branch clean.
15. Provider/subscription interruptions become recoverable waiting states and can be resumed manually.
16. Session restart reconstructs runs, locks, worktrees, and pending recovery actions from private state.
17. Raw operational history remains outside Git and is retained by default.
18. Small direct work remains possible without mandatory harness artifacts or workflow ceremony.

## 24. Design summary

PiBox's harness is a hybrid between a flexible skill-driven agent and a deterministic workflow engine:

- The main Pi session remains the persistent, user-facing authority.
- Specialized agent definitions are independent, configurable contributors with explicit contracts.
- Canonical files preserve semantic truth.
- Private event logs preserve operational truth.
- The planner applies proportional ceremony, groups partial work into meaningful integration units, and assigns task-specific model capability.
- The extension enforces execution authorization, identity, paths, lifecycle, Git isolation, handoffs, and the orchestrator-declared verification plan.
- Evaluation is selectively applied at meaningful boundaries, evidence-backed when used, and repair-bounded.
- Failures pause recoverably rather than being hidden or treated as success.
- Normal Pi freedom remains available whenever the full workflow would be excessive.

This architecture provides strong execution guarantees without making the harness the primary source of engineering judgment.

## 25. Resource-oriented orchestrator authority

The main-session capability surface is a stateless, progressively disclosed resource API over canonical file-backed state. Work items, artifacts, tasks, integration units, and evaluations have stable references, typed validation, and explicit relationships. `workflow_list` exposes compact filterable pages; `workflow_get` exposes summaries and, for a full work-item read, the complete artifact/task/unit/evaluation graph in bounded revision-pinned slices; `workflow_schema` exposes exact mutation contracts on demand. `workflow_plan_write` is the ordinary planning surface: complete create/replacement writes are atomic and revision-pinned surgical edits change only selected resources. `workflow_create`, `workflow_patch`, `workflow_delete`, and `workflow_apply_change` remain compatibility and repair surfaces; successful mutations return receipts rather than full resources.

The orchestrator is the trusted canonical coordinator, not a requirements clerk constrained by its own prior draft. It may revise or remove undelivered resources, reshape integration topology, and amend reviewed planning in response to repository evidence, evaluator findings, or subagent requests. Mutations record rationale and sources. Materially consequential or explicitly user-owned decisions still return to the user, but no approval disposition or status is stored.

`workflow_apply_change` serializes and applies its canonical operations as one Git commit. It does not ask the model to supply revision tokens or contract hashes. Resource errors identify the code, resource reference, retryability, and valid recovery actions so a model does not need to inspect extension source or create a duplicate work item to escape a correctable plan.

Capabilities continue to enforce mechanical truth: schema, identity, relation integrity, idempotency, serialization, clean canonical state, immutable delivery/evidence history, scoped child authority, and explicit finalization locks. They do not determine product materiality or prohibit sound orchestrator judgment. Postponement is resumable; archival creates the explicit finalization lock, and reopening is an auditable transition.
