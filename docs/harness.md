# PiBox Agent Harness

The PiBox harness turns the normal Pi session into a persistent, user-facing orchestrator. Models make semantic decisions; extension capabilities enforce approval, artifacts, identity, Git isolation, structured completion, evidence, and recovery.

The design contract is [`specs/agent-harness.md`](specs/agent-harness.md).

## Load locally

From the PiBox repository:

```bash
pi --no-extensions \
  -e ./extensions/harness/index.ts \
  --theme ./themes/rattle.json
```

When PiBox is installed as a package, the harness extension and its six workflow skills load from `package.json`. After pulling a newer local package revision, use `/reload` or restart Pi.

## Workflow

Initialize a repository deterministically or through natural language:

```text
/harness init [standard|economy]
Scaffold this project to be ready for the harness using the economy profile.
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

- `work_item_create`
- `artifact_create`
- `artifact_update`
- `task_define`
- `evaluation_define`
- `planning_submit`

Planning submission freezes the deliverable-contract digest. Only the user can approve it:

```text
/harness approve <work-item-id>
```

Task boundaries, integration grouping, and evaluator timing remain under orchestrator authority unless the user explicitly makes them binding.

### Execution

- `agent_run` directly invokes a researcher, explorer, critic, reviewer, tester, or other configured role.
- `task_launch` resolves the assigned model, acquires resource claims, allocates a deterministic worktree, and supervises the implementer.
- Workers read canonical context through `task_context` and finish through `task_complete`.
- `task_integrate` assembles every contribution in an integration unit, runs the supplied unit checks, creates one traceable commit, and fast-forwards the canonical branch.

New task worktrees live inside the canonical repository under an ignored root:

```text
<repository>/.worktree/pibox/<work-item>/<task>/
```

`/harness init` ensures `/.worktree/` is ignored. Private run records and credentials remain under `~/.pi/agent/harness/`. Legacy external worktrees remain recoverable through their recorded runtime paths.

A task can intentionally be partial. Review and tests may be deferred until its integration unit is meaningful.

### Evaluation

- `evaluation_launch` runs a planned evaluation in a fresh specialist process with run-scoped evaluator capabilities.
- `evaluation_record` records an orchestrator-curated/manual evaluation.
- Evidence files are copied into the work item and checksummed.
- Findings retain stable IDs and blocking status.
- `work_item_complete` rejects incomplete tasks, missing required evaluation verdicts, stale approval, and unresolved blocking findings.

### Control and recovery

```text
/harness init [standard|economy]
/harness status
/harness pause <task-id>
/harness resume <task-id>
/harness stop <task-id>
/harness recover
```

Capacity failures become recoverable waiting runs. A resumed task keeps its branch, worktree, checkpoint, and repair/protocol budgets. Recovery never resets branches, deletes worktrees, or discards uncommitted worker changes.

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
  maxConcurrency: 4
  protocolNudges: 1
  repairRounds: 2
```

Relative prompt and skill paths are resolved first under `<repository>/.pi/`, then under `~/.pi/agent/harness/`.

Fallback is always visible. Strict unavailable selections enter `waiting_model`; the harness never silently lowers capability rank or effort.

## Durable state

Canonical, committed project records:

```text
agent-artifacts/<work-item-id>/
```

Private operational records:

```text
~/.pi/agent/harness/repositories/<repo-id>/
```

Private records include append-only events, run projections, transcripts, checkpoints, handoffs, operation receipts, locks, and recovery metadata. They are retained by default and never committed.

## Trust and limitations

- Canonical mutations require a clean Git branch and create commits.
- Dirty canonical state fails loudly; the harness never auto-stashes or auto-commits unrelated work.
- Worker and evaluator subprocesses receive only their declared active tools and run-scoped credentials.
- V1 capability scoping is not an OS sandbox. A role with `bash` still has operating-system access available to that process.
- Detached execution, automatic delayed capacity resume, and cross-provider checkpoint restart remain deferred as documented in [`../todo-harness.md`](../todo-harness.md).

## Verification

```bash
npm run verify
npm pack --dry-run
```

The test suite includes configuration and model routing, schema/state transitions, idempotency and locks, private event/run recovery, linked-worktree identity, dirty-branch rejection, supervised terminal handoffs, integration-unit assembly, evidence checksums, and completion gates.
