# PiBox Agent Harness Design Specification

**Status:** Implemented v1
**Date:** 2026-08-10  
**Scope:** Full research, planning, execution, integration, evaluation, and recovery workflow

## 1. Purpose

PiBox will provide a capability-backed development harness for Pi. It will help a persistent main Pi session research work, turn approved intent into durable specifications and designs, plan an executable task graph, delegate isolated work to specialized agents, evaluate the results, integrate approved changes, and recover from interruptions.

The harness is not intended to replace a capable model with a rigid workflow engine. Its central design principle is:

> Models decide semantic work; capabilities enforce mechanical truth.

The main Pi session remains the user's conversational and orchestration authority because it is where user intent, corrections, and decisions enter the system. Child agents advise or contribute bounded work; they do not own process decisions. The extension provides reliable artifacts, lifecycle state, model routing, worktree isolation, role contracts, completion protocols, evaluation gates, and recovery controls.

The workflow scales with the work. A small text or color edit can remain ordinary ad-hoc Pi work. A bounded change can use lightweight artifacts and selective delegation. A complex story can use the complete planning, approval, execution, and evaluation workflow.

The workflow defines phase-level obligations, not a mandatory per-task ceremony. Planning must establish an approved contract; implementation must produce an assembled result; completion must have proportionate evidence. The orchestrator decides whether review and testing happen per task, once for an integration unit, once for the completed work item, or are unnecessary for a low-risk contribution. This explicitly avoids forcing every task through the same implement-review-test-fix loop.

## 2. Design goals

1. Preserve the authority, capability, and flexibility of the main Pi session.
2. Support a complete workflow from research and brainstorming through proportionate integrated evaluation.
3. Treat workflow stages as phase-level requirements rather than a uniform per-task pipeline.
4. Let the orchestrator skip, defer, batch, or combine ceremony according to risk and when the result becomes meaningfully testable.
5. Make filesystem artifacts the durable source of intent, design, task context, decisions, evidence, and outcomes.
6. Keep raw operational history private and outside Git and all worktrees.
7. Make subagent roles independently configurable, measurable, and improvable.
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
- Detached execution that survives the parent Pi process.
- A full-screen subagent sidebar or web dashboard.
- Nested delegation by ordinary worker roles.
- Cross-repository stories or distributed workers.
- Automatic deletion of private history, branches, or worktrees.
- A replacement for normal ad-hoc Pi usage.

Deferred work is tracked in [`../../todo-harness.md`](../../todo-harness.md).

## 4. Core concepts

### 4.1 Main session

The user's normal Pi session is the persistent orchestrator. Research, chat, planning, execution control, evaluation triage, and user decisions all remain in this session.

The main session may:

- Edit directly for small work.
- Call any specialist role directly.
- Start or promote a managed change or story.
- Create and amend canonical artifacts through capabilities.
- Schedule, steer, pause, restart, and stop child agents.
- Judge context impact, task complexity, concurrency, findings, and repair strategy.
- Integrate approved task work.
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
  Full planning, approval, orchestration, and evaluation.
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

Private operational state
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
│   ├── researcher agents
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
    ├── specification reviewers
    ├── quality reviewers
    ├── repair implementers
    └── E2E testers and evidence collectors
```

### 5.2 Extension components

```text
Harness extension
├── Configuration and model resolver
├── Artifact registry
├── Work-item state machine
├── Role and prompt registry
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

The supervisor consumes Pi lifecycle events and process exit status. Child processes remain attached to the main Pi process in v1. If the parent exits, incomplete children are recovered as interrupted runs on the next startup.

The subagent runtime will have an adapter boundary so a future Pi SDK-backed runner can reuse role, lifecycle, capability, and persistence contracts.

## 6. Authority model

### 6.1 Orchestrator authority

The orchestrator may act autonomously while preserving the approved contract. This includes:

- Strengthening task isolation.
- Reordering eligible tasks.
- Adding dependency edges.
- Pausing, steering, restarting, or replacing agents.
- Resolving ordinary implementation details.
- Splitting oversized tasks without changing intent.
- Rejecting incomplete handoffs.
- Requesting additional evaluation.
- Applying non-semantic artifact corrections.
- Selecting a model and effort suitable for task complexity.

### 6.2 Mandatory user escalation

The orchestrator pauses affected work and asks the user before it:

- Changes the work-item intent or desired outcome.
- Materially expands scope.
- Removes or weakens acceptance criteria.
- Contradicts an approved decision.
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
| Assign model and effort | Resolve live model availability and minimum rank |
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
Explicit user approval
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
  status: approved    # draft | awaiting_approval | approved | stale
```

This avoids encoding combinations such as `execution-paused-for-user` into one unmaintainable enum.

### 7.3 Approval gate

Research can flow naturally into planning. Execution cannot begin until the user explicitly approves the planning revision.

Approval is recorded through a deterministic command, not a model-callable tool:

```text
/harness approve <work-item-id>
```

Approval binds to the planning revision and a digest of the deliverable contract. The orchestrator cannot approve its own plan.

The deliverable contract covers intent, requirements, acceptance criteria, and binding user/architecture decisions. Execution mechanics—task boundaries, integration grouping, evaluator placement, and check timing—remain under orchestrator authority unless the user explicitly made one of them binding.

Material changes to the deliverable contract increment the planning revision and mark approval stale. The orchestrator may skip, defer, batch, combine, or strengthen workflow steps without renewed approval when it preserves the contract and required final confidence. Minor formatting or typo corrections may also be classified as non-material.

Out-of-band human edits that change the contract digest fail closed until reconciled.

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
  status: approved
  approvedRevision: 3
  approvedAt: 2026-08-10T10:30:00Z
  contractDigest: sha256:...

artifacts:
  - id: intent
    type: intent
    path: intent.md
    status: approved

  - id: session-identity
    type: spec
    path: specs/session-identity.md
    status: approved
    tags: [sessions, security]

  - id: runtime-architecture
    type: design
    path: design/runtime-architecture.md
    status: approved
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
  isolation: worktree
  parallelism: allowed
  resourceClaims: [session-schema]
  complexity: high
  assignment:
    role: implementer
    model: sol
    effort: high
    minimumCapabilityRank: 200
    allowFallback: true
    rationale: Cross-cutting session lifecycle and concurrency changes

assembly:
  integrationUnit: session-screen
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

Only the main orchestrator can mutate canonical artifacts through dedicated capabilities. Mutations:

1. Acquire the canonical lock.
2. Require a clean feature branch.
3. Validate IDs, types, references, and operation scope.
4. Write through temporary paths.
5. Validate the complete resulting schema.
6. Recompute indexes, revisions, and digests.
7. Commit the transaction.
8. Return a compact receipt.

Multi-file transactions produce one canonical commit. Workers submit amendment and decision requests instead of editing `agent-artifacts/`.

## 9. Planning behavior

### 9.1 Main-session skills

The orchestrator uses focused skills rather than one giant workflow prompt:

```text
harness-research
harness-plan
harness-execute
harness-evaluate
harness-recover
```

These skills describe judgment and behavior. The extension provides the mechanical capabilities.

### 9.2 Research and brainstorming

Planning follows Superpowers-style behavior:

- Investigate the repository before proposing changes.
- Spawn researchers or explorers where they improve understanding.
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
user approval
```

Dimensions represent independently understandable concerns, not arbitrary document-size splits.

### 9.4 Task planning requirements

Each task must be:

- Bounded enough for one implementer context.
- Grounded in explicit canonical artifact references.
- Clear about whether it is a complete behavior or a partial contribution.
- Honest about dependencies and its expected intermediate state.
- Assigned to an integration unit when several tasks must be assembled before they are meaningful.
- Given an isolation policy.
- Given a proportionate verification timing: task, integration-unit, work-item, or intentionally skipped.
- Assigned a model and effort based on complexity.

A task does not need independent acceptance criteria, evaluator runs, or E2E coverage when those checks are meaningless before assembly. It needs a clear contribution contract and a structured handoff. The planner explains where verification is deferred and what later gate covers it.

Parallel tasks cannot depend on one another's unintegrated code. Sequential tasks may build on an orchestrator-controlled integration-unit staging base without advancing the canonical feature branch.

### 9.5 Plan critic

A fresh plan-critic agent checks:

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

The critic reports findings to the orchestrator. It cannot edit canonical artifacts or approve the plan for the user.

## 10. Role system

### 10.1 Role contract

A role is a configurable execution contract rather than a persona:

```yaml
roles:
  implementer:
    prompt: roles/implementer.md
    skills: [testing, implementation]
    tools: [read, grep, find, bash, edit, write]
    workspace: worktree
    canDelegate: false
    completionSchema: implementer-v1
    models:
      - { model: sol, effort: high }
      - { model: terra, effort: high }
```

Each role defines:

- Purpose and behavioral constraints.
- Prompt and skill set.
- Tool and capability allowlist.
- Workspace policy.
- Model and effort candidates.
- Delegation permission.
- Context policy.
- Structured completion schema.
- Version and content digest.

### 10.2 Initial roles

| Role | Responsibility | Mutation authority |
|---|---|---|
| Researcher | External research and source synthesis | None |
| Explorer | Repository investigation and dependency mapping | None |
| Plan critic | Challenge planning artifacts and verification coverage | Findings only |
| Implementer | Implement one bounded task and its tests | Assigned worktree |
| Spec reviewer | Compare implementation with approved requirements | None |
| Quality reviewer | Review correctness, maintainability, regressions, and tests | None |
| Test implementer | Build explicitly tasked automated test infrastructure | Assigned worktree |
| E2E tester | Exercise integrated behavior and collect evidence | Runtime/test environment only |
| Repair implementer | Address accepted evaluator findings | Assigned repair worktree |

Reviewers do not silently fix the work they review. Product or test-infrastructure modifications require an implementer task, preserving evaluator independence.

### 10.3 Direct invocation

Roles remain callable outside a managed workflow. For example:

> Run a quality evaluator on my current edits with GPT-5.6 Sol at high effort.

Direct invocation does not require creating a work item. If the work later becomes managed, relevant findings may be promoted into canonical artifacts.

### 10.4 Prompt composition

A child prompt is assembled from bounded layers:

```text
1. Harness invariants
2. Role contract
3. Repository instructions
4. Task identity and objective
5. Canonical artifact references
6. Runtime and workspace constraints
7. Completion protocol
```

The harness does not inline the entire work-item history. Children retrieve exact durable context through capabilities.

### 10.5 Role performance records

Private run records capture role and prompt versions, skills, requested and resolved model/effort, artifact digests, event traces, completion validation, evaluator outcomes, and repair lineage. This permits later empirical comparison without committing raw transcripts.

## 11. Context and communication

### 11.1 Filesystem-first context

Canonical Markdown and YAML files are the durable communication layer. Tool output and conversational memory are not the sole source of required context.

Children use:

```text
task_context(list)
task_context(read, artifact-id)
task_context(refresh)
```

The capability reads from the orchestrator feature branch, not the child's potentially stale worktree copy.

Responses identify the planning revision and content digests so a child can prove which contract it read.

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

For a context-only clarification:

```text
commit artifact update
  → steer affected child
  → require task_context refresh
  → require digest acknowledgement
  → continue
```

For a code/base dependency change:

```text
pause affected child
  → integrate prerequisite
  → refresh or restart worktree
  → require context refresh
  → continue
```

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

### 12.2 Initial model family

The first version ships with ChatGPT/OpenAI Codex defaults:

```text
capability: Sol > Terra > Luna
```

```yaml
models:
  sol:
    provider: openai-codex
    model: gpt-5.6-sol
    capabilityRank: 300
  terra:
    provider: openai-codex
    model: gpt-5.6-terra
    capabilityRank: 200
  luna:
    provider: openai-codex
    model: gpt-5.6-luna
    capabilityRank: 100
```

Aliases keep policy readable while preserving exact provider/model identities.

### 12.3 Complexity routing

Typical defaults are:

```text
low/ad-hoc    → Luna, medium effort
medium/change → Terra, high effort
high/story    → Sol, high effort
critical      → Sol, high or xhigh effort
```

A role may deliberately prefer a less expensive model and retain stronger fallbacks. A task may require a minimum capability rank.

Each candidate is a model-and-effort pair. Supported Pi thinking levels are:

```text
off | minimal | low | medium | high | xhigh | max
```

The resolver validates the pair against the live model's actual thinking-level map rather than relying on undocumented assumptions.

### 12.4 Resolution order

At spawn time:

1. Apply an explicit user/main-session override.
2. Apply the task assignment.
3. Apply repository role policy.
4. Apply user role policy.
5. Apply built-in role defaults.
6. Filter against Pi's live registry, auth, scoped models, and effort support.
7. Reject candidates below the task's minimum capability rank.
8. Record requested, attempted, and actual selection.

Fallback is visible; no downgrade is silent.

A strict override can prohibit fallback:

> Run the evaluator on GPT-5.6 Sol at high effort, strictly.

If no acceptable candidate exists, the run enters `waiting_model` rather than pretending to execute.

### 12.5 Main-session model selection

The planner and orchestrator may recommend or select a stronger active model when work complexity increases:

```yaml
orchestrator:
  modelSwitching: auto-visible   # off | suggest | auto-visible
```

A user-pinned model wins. Automatic selection is always visible.

### 12.6 Configuration merge and versioning

- Maps merge recursively by key.
- Scalars replace earlier values.
- Arrays replace rather than concatenate.
- Roles may explicitly extend other roles.
- Unknown security-critical fields fail closed.
- Diagnostics identify source file and property path.
- Every run records the effective configuration digest.

Model preference changes do not invalidate semantic approval. The orchestrator may revise evaluator placement and check timing while preserving the deliverable contract and required final confidence. Broadening role authority, removing a user-mandated control, or weakening a binding security or acceptance obligation requires review.

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

### 13.2 Integration units

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

The orchestrator chooses which tasks to launch, whether concurrency is appropriate, and whether a task starts from the canonical branch or an integration-unit staging base. The extension rejects launches when:

- The declared base or dependencies are not available.
- Planning is unapproved or stale.
- A required resource is locked.
- The concurrency limit is reached.
- The feature branch is dirty when a clean canonical operation is required.
- Worktree allocation fails.

### 13.5 Worktree allocation

```text
branch:
  harness/<work-item-id>/<task-id>

worktree:
  ~/.pi/agent/harness/worktrees/
    <repo-id>/<work-item-id>/<task-id>
```

Allocation acquires a lock, verifies the selected base, records its exact commit, checks branch/path ownership, creates or recovers the worktree, and launches the child with fixed `cwd`.

The harness never auto-stashes or auto-commits a dirty feature branch.

### 13.6 Worker completion requirements

An implementation task must finish with:

- A clean worker worktree.
- One or more task-branch commits.
- A structured contribution summary.
- The checks the planner assigned to this task, which may be none.
- Explicit disclosure of expected failures or incomplete assembly state.
- No changes under `agent-artifacts/`.
- No unacknowledged context amendments.

A task is not required to claim full acceptance, pass the whole repository build, or run E2E when the approved execution strategy defers those obligations. The extension validates actual Git state and the declared handoff rather than imposing a universal test checklist.

## 14. Assembly and integration

### 14.1 Ownership

Children commit only to task branches. The orchestrator alone owns integration-unit staging refs and the canonical feature branch. Reviewers inspect whichever boundary the orchestrator assigns: a task branch, integration unit, or completed work-item candidate.

### 14.2 Integration-unit staging

```text
task branches
    ↓
orchestrator-controlled unit candidate/worktree
    ↓
apply contributions serially
    ↓
resolve or repair assembly issues
    ↓
run the unit's declared checks, if any
    ↓
publish the unit to the canonical feature branch
```

The unit candidate allows multiple task contributions to become coherent before the feature branch advances. Dependent tasks can use durable unit staging commits as controlled bases.

A unit marked `partial-allowed` may temporarily fail a broad repository build when that failure is an explicit part of the plan. The orchestrator must still preserve Git cleanliness, traceability, and the declared later gate that will close the gap.

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

Evaluation is required at the level necessary to establish confidence in the approved deliverable, not once per task. The planner and main orchestrator decide the cheapest meaningful verification boundary.

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

The plan critic challenges missing final confidence, not the absence of per-task ceremony.

### 15.3 Orchestrator discretion

The orchestrator may:

- Skip evaluation for trivial or purely structural contributions.
- Combine spec and quality concerns into one evaluator prompt when that is efficient.
- Batch review across several related tasks.
- Defer build or tests until all required pieces are assembled.
- Run targeted tests instead of the full suite.
- Omit E2E when there is no meaningful user journey or the risk does not justify it.
- Add stronger checks when implementation findings increase risk.

These changes do not require renewed user approval unless they weaken a user-mandated control, leave a binding acceptance criterion without credible proof, or alter a security/quality boundary the user approved.

Child reviewers and evaluators can recommend additional checks, but the main orchestrator decides whether those checks become workflow requirements.

### 15.4 Available evaluation methods

Methods are composable tools, not mandatory stages:

1. **Deterministic checks:** build, types, targeted or full tests, lint, formatting, path restrictions, clean worktree, generated outputs, and repository commands.
2. **Specification review:** compare an assembled result against approved intent, requirements, design constraints, and acceptance criteria.
3. **Quality review:** assess correctness, edge cases, maintainability, regressions, security, error handling, and test quality.
4. **Integrated regression:** check interaction with the latest canonical base.
5. **E2E evaluation:** exercise a meaningful assembled user journey and collect evidence.

A planner may combine specification and quality review into one run. Independent roles remain available when risk warrants separation.

### 15.5 Evaluator independence

When an evaluator is used, it runs in a fresh session and receives approved artifacts, the assigned task/unit/work-item diff, structured handoffs, and evidence manifests. It does not receive implementer raw transcripts or private reasoning.

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

The orchestrator triages findings as `accepted`, `rejected`, `duplicate`, `deferred`, or `needs_user`. Rejection requires rationale. Deferring a blocking approved criterion normally requires user approval.

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

- Every required contribution is assembled or removed through an approved contract revision.
- The orchestrator has run the current verification plan at its declared boundaries.
- Binding acceptance criteria have proportionate final evidence or an explicit justified disposition.
- No accepted blocking finding remains.
- Canonical artifacts match the approved deliverable contract.
- The feature branch is clean.
- `outcome.md` records delivery, deviations, evidence, skipped/deferred checks, and remaining non-blocking risks.

## 16. Capability API

### 16.1 Orchestrator artifact capabilities

```text
harness_init
work_item_create
work_item_status
artifact_create
artifact_update
artifact_link
artifact_reconcile
planning_submit
task_define
task_update
evaluation_define
```

### 16.2 Execution capabilities

```text
agent_run
task_launch
agent_control
agent_status
task_integrate
evaluation_launch
evaluation_record
work_item_complete
harness_status
```

`agent_run` directly invokes a role without requiring a work item. `task_launch` additionally enforces approval, dependencies, worktree allocation, and task contracts.

### 16.3 Worker capabilities

```text
task_context
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
STALE_PLANNING_REVISION
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
└── worktrees/
    └── <repo-id>/<work-item-id>/<task-id>/
```

Children interact through capabilities and do not choose operational paths.

### 17.2 Event log

Each run records append-only sequenced events. Mutable state files are projections. When projections disagree, the harness replays events and reconciles them with Git.

### 17.3 Locks

Locks protect repository integration, worktree allocation, canonical artifact mutation, resource claims, and per-task active ownership. Locks include owner, process identity, acquisition time, and heartbeat. Stale locks are diagnosed before removal.

### 17.4 Retention

Private operational history is retained permanently by default. The harness does not automatically delete transcripts, command output, branches, or worktrees. Explicit inspection, export, redaction, deletion, and cleanup commands are deferred.

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
/harness resume
/harness resume <task-id>
/harness resume --provider openai-codex
```

Resume rechecks model availability, resolves fallback policy, validates canonical and worker Git state, verifies planning revision and context digest, and starts a fresh attempt from the existing branch/checkpoint.

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

### 18.7 Agent controls

```text
agent_status
agent_control(pause | stop)
/harness pause <task>
/harness resume <task>
/harness stop <task>
```

Pause or stop terminates the active supervised process while preserving filesystem and private run state. Resume launches a fresh model session against the retained branch and checkpoint. Rich live steering, restart policies, and inbox controls remain deferred.

## 19. User experience

### 19.1 Natural-language first

The intended interface is ordinary conversation:

> Research and plan a story for replacing the session model.

> Execute the approved session-model story.

> Run a quality reviewer on my current changes using Sol at high effort.

> Pause the persistence task.

The orchestrator translates user intent into capabilities.

### 19.2 Deterministic commands

Commands remain available when a model is unavailable or exact control is preferred:

```text
/harness init [standard|economy]
/harness status
/harness agents
/harness approve <work-item>
/harness pause [task]
/harness resume [task]
/harness stop [task]
/harness recover
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

- Plan ready for approval.
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
- Approval and context revision gates.
- Locks, idempotency, and recovery records.

### 20.2 V1 limitation

Without OS-level sandboxing, an agent with `bash` may technically access paths beyond its assigned worktree. Tool allowlists and post-run checks reduce accidental violations but are not a security boundary against a malicious or prompt-injected process.

The capability API is intentionally designed so a later sandbox can enforce filesystem, network, process, and private-state boundaries without changing role contracts.

### 20.3 Trusted repository configuration

Repository role prompts, skills, and tool policies are executable agent configuration. The harness loads them only after Pi's project-trust mechanism accepts the repository.

## 21. Harness verification strategy

The harness itself requires deterministic and model-assisted testing.

### 21.1 Unit tests

- Schema validation and migrations.
- Configuration merge semantics.
- Model and effort resolution.
- Capability authorization.
- State-machine transitions.
- Planning digest and approval invalidation.
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

### 21.4 Role and prompt evaluations

Role behavior is evaluated separately from deterministic extension correctness. Versioned datasets should compare planner coverage, implementer protocol compliance, reviewer precision, false-positive rate, E2E drivability, model selection, and repair success.

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

Relevant lessons include role files, model overrides, run observability, background/fleet concepts, and nested transcript presentation. Background execution, nested delegation, and a fleet UI remain deferred unless needed by the approved first implementation.

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
3. Execution cannot begin without direct user approval of the current deliverable contract revision.
4. The planner can explicitly skip, defer, batch, or combine task-level review and testing while declaring the later meaningful verification boundary.
5. Partial task contributions can be assembled in an orchestrator-controlled integration unit without pretending they are independently complete.
6. Role prompts, tools, models, effort, and fallback lists can be set globally and overridden per repository.
7. The planner records model/effort assignments per task and the runtime resolves them against Pi availability.
8. Missing models fall back visibly or enter a waiting state without silent downgrade.
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
- Specialized roles are independent, configurable contributors with explicit contracts.
- Canonical files preserve semantic truth.
- Private event logs preserve operational truth.
- The planner applies proportional ceremony, groups partial work into meaningful integration units, and assigns task-specific model capability.
- The extension enforces approval, identity, paths, lifecycle, Git isolation, handoffs, and the orchestrator-declared verification plan.
- Evaluation is selectively applied at meaningful boundaries, evidence-backed when used, and repair-bounded.
- Failures pause recoverably rather than being hidden or treated as success.
- Normal Pi freedom remains available whenever the full workflow would be excessive.

This architecture provides strong execution guarantees without making the harness the primary source of engineering judgment.
