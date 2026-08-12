# PiBox Managed Workflow

The PiBox managed workflow turns the normal Pi session into a persistent, user-facing orchestrator. Models make semantic and materiality decisions; extension capabilities enforce resource format, identity, referential integrity, atomic Git mutation, isolation, structured completion, evidence, and recovery.

The design contract is [`specs/agent-workflow.md`](specs/agent-workflow.md).

## Load locally

From the PiBox repository:

```bash
pi --no-extensions \
  -e ./extensions/workflow-runtime/index.ts \
  -e ./extensions/workflow/index.ts \
  --theme ./themes/rattle.json
```

When PiBox is installed as a package, the workflow extensions and three workflow skills load from `package.json`. After pulling a newer local package revision, use `/reload` or restart Pi.

## Workflow

Initialize a repository deterministically or through natural language:

```text
/workflow init [standard|economy]
Scaffold this project for managed workflows using the economy profile.
```

Initialization validates and commits `.pi/harness.yaml`. It never overwrites an existing policy or hides unrelated dirty work unless explicitly directed.

You can then speak naturally:

```text
Research and plan a story for replacing the session model.
Execute the approved session-model story.
Run the planned combined review for the session-runtime unit.
Recover the interrupted persistence task.
```

The main session selects ad-hoc work when ceremony is unnecessary. Managed work uses these capabilities:

### Planning

Managed planning begins as a product and technical conversation, not an artifact write. The orchestrator recovers the outcome behind a proposed solution, inspects discoverable facts, and treats inherited product rules, UX/UI flows, schemas, APIs, and architecture as revisitable decisions when they manufacture contradictory guarantees or disproportionate complexity. It distinguishes symptoms, technical causes, and upstream enabling conditions for bug work; probes only materially consequential hidden cases; and stops discovery when another answer would not change the contract. Clear local reversible work remains ad hoc even when the user asks for a plan.

The user settles or delegates consequential choices. Once both sides share an understanding, the orchestrator drafts and submits the coherent contract, then offers two natural next steps: refine it conversationally, or approve it with `/workflow approve <work-item-id>`. No magic readiness phrase is required.

- `workflow_list` and `workflow_get` inspect complete canonical resources and revisions.
- `workflow_create`, `workflow_patch`, and `workflow_delete` provide resource-oriented CRUD over work items, artifacts, tasks, integration units, and evaluations.
- `workflow_apply_change` applies a coherent multi-resource amendment as one canonical commit and can resolve a subagent request in the same orchestration decision.
- `workflow_transition` submits, postpones, resumes, archives, reopens, or otherwise advances a resource lifecycle.

Legacy resource-specific planning tools remain registered for compatibility but are hidden from the normal main-session tool surface.
Schema-v2 narrative capabilities accept typed semantic sections and render stable Markdown for intent, specifications, designs, decisions, task briefs, and task acceptance. Required values fail when empty or placeholder-only; optional sections may be omitted. Evaluation reports and outcomes are rendered from structured evidence, findings, verification, and residual risk. Schema-v1 artifacts remain readable for compatibility.

Initial planning submission records the plan as awaiting approval. Only the user can grant initial approval:

```text
/workflow approve <work-item-id>
```

Approval is continuity rather than a blanket mutation freeze. The main orchestrator may revise approved specs, designs, tasks, integration units, and evaluations with an audited `retain-approval` amendment when the change remains within delegated intent. It uses `request-user` only for a material user-owned decision. Each amendment records rationale, provenance, and impact; immutable run, evidence, handoff, and integration history is never rewritten. Task boundaries, integration grouping, and evaluator timing remain under orchestrator authority unless the user explicitly makes them binding.

### Exploration and execution

The independent workflow extension owns the generic background execution surface. Each work item separates planning kind (`story | change`) from delivery intent (`feature | fix`, `create | continue`, base `develop`). For new delivery, `workflow_start` requires a clean checkout, switches to `develop`, pulls with `--ff-only`, and creates `feature/<work-item-id>` or `fix/<work-item-id>`. For continued delivery, it requires a clean checkout already on the recorded ongoing feature/fix branch and does not sync `develop`. It then asks the registered managed-work adapter to derive current task, task-merge, and evaluation steps directly from the approved work item. A dirty checkout fails visibly so the orchestrator can inspect legitimate recovery work, offer commit/stash/task-state choices, and resume without discarding state. It refreshes canonical state after each step and on a polling fallback, advances routine ready work, and pauses once when attention is required. Its widget above the editor shows current step progress. Esc aborts only the current interactive turn; detached workflow children continue until explicit workflow/subagent control stops them.

- `subagent_spawn` starts an adapter-owned task or evaluation reference in background mode by default; foreground mode remains available for explicit waiting.
- `subagent_status`, `subagent_control`, and `subagent_respond` monitor and steer logical children.
- `workflow_control` pauses scheduling, resumes it, or stops active children.
- `exploration_launch` retains its typed read-only evidence assignment outside managed workflow execution.
- `agent_run` retains direct specialist invocation outside a managed work item.
- Workers receive a focused task packet in their persistent system context. `task_clarify` provides optional, targeted access to broader story/change context when a concrete uncertainty remains; `task_complete` records completion.

The managed-work adapter continues to own feature-branch preparation, repository/worktree isolation, queued task merges, checks, evaluator contracts, and canonical state transitions. Work-item `executionStages` provide the ordered workflow spine; tasks inside one stage are a deliberate concurrency batch and merge in listed order before the next stage advances. Repository-isolated tasks commit directly to the feature branch, while worktree-isolated tasks merge back as a mini-step in their own lifecycle. The generic runtime contains no canonical artifact or approval logic.

New task worktrees live inside the canonical repository under an ignored root:

```text
<repository>/.worktree/pibox/<work-item>/<task>/
```

`/workflow init` ensures `/.worktree/` and `/.pibox/` are ignored. Repository-local runtime records—including transcripts, logs, handoffs, locks, and receipts—live under `/.pibox/`; global configuration and credentials remain under `~/.pi/agent/harness/`. Legacy external worktrees remain recoverable through their recorded runtime paths.

A task can intentionally be partial. Task-level review/repair may happen before merge, while whole-feature E2E and final review run on the assembled delivery branch. Completion leaves the branch checked out. A newly created branch is reported ready to merge into `develop`; completion on a continued branch reports only the delivered increment and does not imply the larger branch is finished.

### Evaluation

- Planned evaluations become workflow subagent steps after their declared task, integration-unit, or work-item boundary is ready.
- `evaluation_record` records an orchestrator-curated/manual evaluation.
- Evidence files are copied into the work item and checksummed.
- Findings retain stable IDs and blocking status.
- `work_item_complete` rejects incomplete tasks, missing required evaluation verdicts, stale approval, and unresolved blocking findings.

### Control and recovery

```text
/workflow init [standard|economy]
/workflow status
/workflow pause <task-id>
/workflow resume <task-id>
/workflow stop <task-id>
/workflow recover
/harness worktrees
/harness worktrees cleanupAll
/harness worktrees remove <work-item/task> [--force]
```

Every model-backed direct child is registered under the stable main Pi session identity before process creation. The main session is depth zero; children are depth one and cannot delegate. A logical child retains one of sixteen default slots through running, waiting, blocking, pausing, interruption, handoff reporting, and later process attempts. Only a terminal completion, failure, protocol failure, or cancellation releases the slot.

Child stdout, stderr, transcript, heartbeat, checkpoint, messages, and handoff are file-backed under private session state. Exiting the main Pi process does not stop children. On resume, the registry checks durable handoffs before liveness, preserves positively identified live work, marks dead children without handoff interrupted, and treats stale-heartbeat PID ambiguity as recovery-required rather than launching a duplicate writer.

Decision reports are asynchronous and non-blocking. Change requests and blockers checkpoint safe work and retain their logical slot while the main orchestrator judges materiality. Routine requests can be accepted or rejected, applied through an atomic `workflow_apply_change`, answered durably, and resumed without asking the user or discarding approval continuity. No live main-process RPC is required. Capacity failures remain explicit and require manual resume. Recovery never resets branches, deletes worktrees, or discards uncommitted worker changes.

## Configuration

Configuration precedence is:

```text
built-ins
  → ~/.pi/agent/harness/config.yaml
  → <repository>/.pi/harness.yaml
  → task assignment
  → direct spawn override
```

Maps merge recursively; arrays replace. Unknown security-sensitive fields fail closed. Repository configuration loads only for a trusted project.

Example:

```yaml
schemaVersion: 1

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

roles:
  implementer:
    prompt: roles/implementer.md
    skills: [skills/repository-testing/SKILL.md]
    tools: [read, grep, find, bash, edit, write]
    workspace: worktree
    canDelegate: false
    completionSchema: implementer-v1
    models:
      - { model: sol, effort: high }
      - { model: terra, effort: high }

  fast-reviewer:
    extends: quality-reviewer
    tools: [read, grep, find]
    models:
      - { model: terra, effort: medium }

orchestrator:
  modelSwitching: auto-visible

limits:
  maxConcurrency: 4 # legacy schema-v1 process preference
  maxActiveSubagentsPerSession: 16
  maxSubagentDepth: 1
  protocolNudges: 1
  repairRounds: 2
```

Relative prompt and skill paths are resolved first under `<repository>/.pi/`, then under `~/.pi/agent/harness/`.

Fallback is always visible. Strict unavailable selections enter `waiting_model`; the workflow never silently lowers capability rank or effort.

## Durable state

Canonical, committed project records:

```text
agent-artifacts/<work-item-id>/
```

Ignored repository-local operational records:

```text
.pibox/
```

These records include append-only events, run projections, transcripts, checkpoints, handoffs, operation receipts, locks, and recovery metadata. They are retained by default and never committed. `/harness worktrees cleanupAll` removes only clean, inactive PiBox task worktrees; dirty or active worktrees require explicit recovery or a named forced removal.

## Trust and limitations

- Canonical mutations require a clean Git branch and create commits.
- Dirty canonical state fails loudly; the workflow never auto-stashes or auto-commits unrelated work.
- Worker and evaluator subprocesses receive only their declared active tools and run-scoped credentials.
- V1 capability scoping is not an OS sandbox. A role with `bash` still has operating-system access available to that process.
- Detached execution, automatic delayed capacity resume, and cross-provider checkpoint restart remain deferred in the internal backlog.

## Verification

```bash
npm run verify
npm pack --dry-run
```

The test suite includes configuration and model routing, schema/state transitions, idempotency and locks, private event/run recovery, linked-worktree identity, dirty-branch rejection, supervised terminal handoffs, integration-unit assembly, evidence checksums, and completion gates.
