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
/harness init [standard|economy]
/workflow init [standard|economy]   # compatibility alias
Initialize this project for managed workflows using the economy profile.
```

The model can invoke the same operation through `workflow_init`. Initialization creates Git only for an empty directory, ensures and checks out `develop`, appends `/.worktree/` and `/.pibox/` to an existing `.gitignore`, writes an explicit `.pi/harness.yaml` (including model-effort tier routes), initializes ignored `.pibox/` runtime metadata, and commits only harness-owned files. It refuses to wrap or stage files from an existing non-Git project; establish and commit that baseline first. Existing policies are validated and are not overwritten unless explicitly requested.

You can then speak naturally:

```text
Research and plan a story for replacing the session model.
Start the reviewed session-model story.
Run the planned combined review for the session-runtime unit.
Recover the interrupted persistence task.
```

The main session selects ad-hoc work when ceremony is unnecessary. Managed work uses these capabilities:

### Planning

Managed planning begins as a product and technical conversation, not an artifact write. The orchestrator recovers the outcome behind a proposed solution, inspects discoverable facts, and treats inherited product rules, UX/UI flows, schemas, APIs, and architecture as revisitable decisions when they manufacture contradictory guarantees or disproportionate complexity. It distinguishes symptoms, technical causes, and upstream enabling conditions for bug work; probes only materially consequential hidden cases; and stops discovery when another answer would not change the contract. Clear local reversible work remains ad hoc even when the user asks for a plan.

The user settles or delegates consequential choices. Once both sides share an understanding, the orchestrator writes the complete draft atomically, reads the whole plan at that exact revision back, and performs one lightweight self-review for requirement coverage, vague placeholders, and cross-task consistency. If needed, it applies one revision-pinned surgical edit without resending unchanged plan content, then submits and hands the plan to the user. It offers two natural next steps: refine it conversationally, or say “start the workflow.” The explicit start request is the sole execution gate.

- `workflow_plan_write` atomically creates or completely replaces a plan, and applies revision-pinned resource-level edits for post-write corrections. `create` always uses a new ID and treats `basedOn` as read-only context; complete `update` and surgical `edit` require the exact target and expected revision. Harness-owned lifecycle/schema boilerplate is defaulted, while structured task briefs and acceptance contracts remain mandatory because they become fresh-agent context.
- `subagent_spawn` invokes any configured agent definition with a task prompt and defaults to background execution. Its live tool description inventories the validated built-in, configured, and trusted project agents. `plan-critic` remains optional when the user asks for an independent critique; ordinary plans do not wait for it.
- `workflow_list` returns compact filtered catalog pages with snapshot-pinned cursors.
- `workflow_get` returns a compact summary by default. For work items, `view=full` returns the complete plan graph—including artifact contents, task briefs and acceptance contracts, integration units, and evaluations—in bounded revision-pinned ranges.
- `workflow_schema` progressively discloses exact mutation contracts only when a model needs them, keeping always-visible tool schemas small.
- `workflow_create`, `workflow_patch`, `workflow_delete`, and `workflow_apply_change` remain targeted compatibility/repair surfaces rather than the ordinary plan-writing path.
- `workflow_transition` submits, postpones, resumes, archives, reopens, or otherwise advances a resource lifecycle.

Legacy resource-specific planning tools remain registered for compatibility but are hidden from the normal main-session tool surface.
Schema-v2 narrative capabilities accept typed semantic sections and render stable Markdown for intent, specifications, designs, decisions, task briefs, and task acceptance. Required values fail when empty or placeholder-only; optional sections may be omitted. Evaluation reports and outcomes are rendered from structured evidence, findings, verification, and residual risk. Schema-v1 artifacts remain readable for compatibility.

Planning submission validates the execution topology and marks the review handoff; it does not create an approval status. The plan stores only its revision. A clear user request to start or run that reviewed workflow authorizes `workflow_start`; planning, review, acknowledgement, or a problem report alone does not. The permission extension then owns a TUI confirmation explaining that unattended workflow execution runs in bypass mode. Cancellation launches nothing; successful preparation and snapshot validation switch the parent session and inherited child mode to bypass before scheduling. Resource mutations retain rationale and provenance, while immutable run, evidence, handoff, and integration history is never rewritten.

### Exploration and execution

The repository tool permission policy is loaded from `.pi/permissions.yaml`. `Shift+Tab` or `/permissions` switches between visible Enforced and Bypass modes; direct and managed children inherit the parent session mode. Enforced `ask` decisions prompt only in the interactive TUI and fail closed in headless children. Bypass skips that policy but leaves workflow authority, Git isolation, review, verification, and recovery controls intact. See [`extensions/permissions/README.md`](../extensions/permissions/README.md).

The independent workflow extension owns the generic background execution surface. Each work item separates planning kind (`story | change`) from delivery intent (`feature | fix`, `create | continue`, base `develop`). For new delivery, `workflow_start` requires a clean checkout, switches to `develop`, pulls with `--ff-only`, and creates `feature/<work-item-id>` or `fix/<work-item-id>`. For continued delivery, it requires a clean checkout already on the recorded ongoing feature/fix branch and does not sync `develop`. It then asks the registered managed-work adapter to derive current task, task-merge, and evaluation steps directly from the reviewed work item. A dirty checkout fails visibly so the orchestrator can inspect legitimate recovery work, offer commit/stash/task-state choices, and resume without discarding state. It refreshes canonical state after each step and on a polling fallback, advances routine ready work, and pauses once when attention is required. Its widget above the editor shows current step progress. Esc aborts only the current interactive turn; detached workflow children continue until explicit workflow/subagent control stops them.

- `subagent_spawn` dynamically launches a configured agent definition with a task prompt in foreground mode by default; background mode is available for independent concurrent work. Its optional tier selects the configured fallback list, while an optional model preference (plain model, `provider/model`, or either suffixed with `#effort`) is promoted ahead of that list and an explicit effort field overrides the suffix. Use `general-purpose` for open-ended assignments, `explorer` for fast read-only repository lookup, or `investigator` for medium-tier causal diagnosis. Children receive the tool policy from their agent-definition frontmatter without workflow or subagent controls and cannot delegate recursively. A foreground launch renders as an inline pulsing agent row until its terminal report returns as the blocking tool result. A background launch returns immediately, shows one pulsing footer row per active child with its agent name, resolved model/effort, and elapsed time, then injects the terminal report with a built-in response prompt and starts a main-agent follow-up turn.
- `subagent_status`, `subagent_control`, and `subagent_respond` monitor and steer logical children.
- `workflow_control` pauses scheduling, resumes it, or stops active children.
- Managed task and evaluation spawning is internal to `workflow_start`/resume and uses the same launch coordinator and lifecycle registry as dynamic `subagent_spawn` calls.
- Agent definitions remain generic. Managed launches append workflow protocol prompts from `prompt/workflow-*-agent.md`; direct user launches receive only the selected agent definition and assignment.
- Built-in and trusted repository `.pi/agents/*.md` definitions use conventional Pi frontmatter (`name`, `description`, optional `tools` and `model`) plus optional PiBox `tier: low | medium | high | max`. Omitted tiers default to `medium`; valid project definitions override catalog entries with the same name, while invalid files are skipped with diagnostics. Agent-definition frontmatter is the sole authority for the child's base tool policy; `tools` entries in global or repository `harness.yaml` policy are ignored. Omission preserves the default child tool set. The `"*"` selector enables every configured child tool and may be combined with other selectors as a simple union; workflow and recursive subagent controls remain unavailable. Namespaced selectors such as `pibox:task` and `pibox:evaluation` expand through one central group registry; managed launches add only the required group at runtime rather than hardcoding capability lists at each launch site. A selector such as `mcp:playwright` optionally enables the independently installed `pi-mcp-adapter` proxy and scopes it to that registered server unless `"*"` makes every configured server available. Missing adapters or server definitions are ignored rather than invalidating the agent; no MCP transport, command, credential, or version is stored in harness configuration.
- Agents receive a focused task packet in persistent system context. Reviewers receive their scoped task contracts plus full specification and design context through the same compaction-resistant mechanism. `task_clarify` provides optional targeted context; structured completion tools record durable handoffs. Managed implementers and repair agents read the latest ten rows from a private work-item workflow ledger before starting and append one concise row before handing off; code reviewers and E2E evaluators never receive the ledger tool.

MCP ownership stays outside PiBox: install and update `pi-mcp-adapter` with Pi, then register `playwright`, `context7`, or other server names in the adapter's standard user/project `mcp.json`. PiBox stores only selectors in agent definitions. The built-ins currently request Playwright for `e2e-tester`, Context7 for `implementer`, and all configured servers through `"*"` for `general-purpose`; the main session uses the adapter's ordinary user configuration directly.

The managed-work adapter continues to own feature-branch preparation, stage-mode-specific isolation, checks, evaluator contracts, and canonical state transitions. Work-item `executionStages` are the complete ordered topology, and each stage may declare `mode: sequential | concurrent`. A sequential stage runs tasks in declared order on the canonical `feature/<work-item>` branch, integrating each task before launching the next. A concurrent stage launches independent tasks in individual worktrees from one pinned common base, waits for every contribution, merges the batch in declared order through one atomic barrier, and then publishes it. For backward compatibility, omitted mode resolves to sequential for a singleton stage and concurrent for a multi-task stage; new plans should declare it explicitly. Every assembled stage runs its required checks. Stage review/fix remains the legacy default, while a planner may explicitly skip one low-risk stage with a substantive rationale when deterministic checks cover its complete boundary. After assembly, the runtime reviews the exact `executionStartCommit..reviewedCommit` feature diff as one integrated change before final E2E. Structured E2E settlement requires every approved matrix case exactly once and cannot pass or be accepted as risk while any case is failed or blocked. Planners do not encode `isolation` or `parallelism`, and user authority over material decisions and execution authorization remains unchanged. The generic runtime contains no canonical artifact or plan-approval logic.

New task worktrees live inside the canonical repository under an ignored root:

```text
<repository>/.worktree/pibox/<work-item>/<task>/
```

`/harness init` ensures `/.worktree/` and `/.pibox/` are ignored. Repository-local runtime records—including transcripts, logs, handoffs, locks, and receipts—live under `/.pibox/`; global configuration and credentials remain under `~/.pi/agent/harness/`. Legacy external worktrees remain recoverable through their recorded runtime paths.

A task can intentionally be partial. A required stage review/fix follows stage checks and settlement; an explicitly skipped low-risk review advances from green deterministic checks. Whole-branch review then evaluates the exact assembled feature diff before final E2E exercises every approved journey. Completion leaves the branch checked out. A newly created branch is reported ready to merge into `develop`; completion on a continued branch reports only the delivered increment and does not imply the larger branch is finished.

### Evaluation

- Planned evaluations become workflow subagent steps after their declared task, integration-unit, or work-item boundary is ready.
- `evaluation_record` records an orchestrator-curated/manual evaluation.
- Evidence files are copied into the work item and checksummed.
- Findings retain stable IDs and blocking status.
- `work_item_complete` rejects incomplete tasks, missing required evaluation verdicts, unresolved blocking findings, and final E2E results that omit or block an approved matrix case.

### Control and recovery

```text
/harness init [standard|economy]
/workflow status
/workflow pause <task-id>
/workflow resume <task-id>
/workflow stop <task-id>
/workflow recover
/harness worktrees
/harness worktrees sizes
/harness worktrees cleanupAll
/harness worktrees remove <work-item/task> [--force]
```

The default worktree inventory reports ownership, activity, and Git status without recursively scanning build outputs. Use `sizes` only when exact per-worktree disk usage is needed. Inspection and cleanup show live progress in the TUI and can be cancelled with Escape; session shutdown requests the same cancellation. Read-only inspection stops immediately, while cleanup finishes the current Git removal before stopping at the next safe boundary. Cleanup inspects once, revalidates each candidate immediately before serial removal, and retains every worktree branch.

Every model-backed direct child is registered under the stable main Pi session identity before process creation. The main session is depth zero; children are depth one and cannot delegate. A logical child retains one of sixteen default slots through running, waiting, blocking, pausing, interruption, handoff reporting, and later process attempts. Only a terminal completion, failure, protocol failure, or cancellation releases the slot.

Child stdout, stderr, transcript, heartbeat, checkpoint, messages, and handoff are file-backed under private session state. Exiting the main Pi process does not stop children. On resume, the registry checks durable handoffs before liveness, preserves positively identified live work, marks dead children without handoff interrupted, and treats stale-heartbeat PID ambiguity as recovery-required rather than launching a duplicate writer.

Decision reports are asynchronous and non-blocking. Change requests and blockers checkpoint safe work and retain their logical slot while the main orchestrator judges materiality. Routine requests can be accepted or rejected, applied through an atomic `workflow_apply_change`, answered durably, and resumed without asking the user. No live main-process RPC is required. Capacity failures remain explicit and require manual resume. Recovery never resets branches, deletes worktrees, or discards uncommitted worker changes.

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
schemaVersion: 2

modelTierListProfiles:
  defaultProfile: performance
  profiles:
    performance:
      max: [openai-codex/gpt-5.6-sol#max]
      high: [openai-codex/gpt-5.6-sol#high]
      medium: [openai-codex/gpt-5.6-sol#medium]
      low: [openai-codex/gpt-5.6-luna#high]
      local: [local-llm/meta/muse-glimmer#high]
    token-conservative:
      max: [openai-codex/gpt-5.6-sol#max]
      high: [openai-codex/gpt-5.6-sol#high]
      medium: [openai-codex/gpt-5.6-luna#max]
      low: [openai-codex/gpt-5.6-luna#high]
      local: [local-llm/meta/muse-glimmer#high]

agents:
  implementer:
    prompt: ../agent-definitions/implementer.md
    skills: [skills/repository-testing/SKILL.md]
    workspace: worktree
    canDelegate: false
    completionSchema: implementer-v1
    tier: medium

  deep-reviewer:
    extends: code-reviewer
    tier: high

orchestrator:
  modelSwitching: auto-visible

limits:
  maxConcurrency: 4
  maxActiveSubagentsPerSession: 16
  maxSubagentDepth: 1
  protocolNudges: 1
  repairRounds: 2
```

Relative prompt and skill paths are resolved first under `<repository>/.pi/`, then under `~/.pi/agent/harness/`. Built-in reusable agent definitions live in `agent-definitions/`; editable harness prompt fragments live in `prompt/`. Put tool declarations and MCP selectors in those Markdown definitions, not harness policy.

Task plans select only `low | medium | high | max`. Dynamic `subagent_spawn` calls may additionally select `local`. When the tier is omitted, an explicit `local-llm/...` model infers `local`; every other request retains the `medium` default. The local list is provider-isolated: every route must use `local-llm`, model overrides are matched only inside that list, and local routes never participate in ordinary-tier override promotion. An explicit local model request is strict: an unknown model id, unavailable model, or unsupported effort returns `MODEL_UNAVAILABLE` without trying another local route or any paid provider. Each tier is an ordered list of `provider/model#effort` entries, so model capability and reasoning cost are tuned together in policy rather than guessed independently by the planner. Unsupported or unavailable pairs are skipped in order. If a launched provider later exhausts rate/subscription capacity, authentication, bounded transport retries, or server availability, the common child coordinator keeps the same logical agent/session/workspace and transparently tries the next usable same-tier provider. Intermediate failure output is retained privately rather than returned to a waiting foreground caller. Context, cancellation, protocol, tool, and implementation failures do not change providers; strict concrete overrides do not fall back. An exhausted tier enters `waiting_model` or `waiting_capacity` without capability downgrade or effort clamping.

## Durable state

Canonical, committed project records:

```text
agent-artifacts/<work-item-id>/
```

Ignored repository-local operational records:

```text
.pibox/
```

These records include append-only events, run projections, transcripts, checkpoints, handoffs, operation receipts, locks, and recovery metadata. They are retained by default and never committed. `/harness worktrees cleanupAll` removes only clean, inactive PiBox task worktrees; dirty or active worktrees require explicit recovery or a named forced removal. Ignored build output inside a clean inactive worktree is disposable and is removed with that worktree.

## Trust and limitations

- Canonical mutations require a clean Git branch and create commits.
- Dirty canonical state fails loudly; the workflow never auto-stashes or auto-commits unrelated work.
- Worker and evaluator subprocesses receive only their declared active tools and run-scoped credentials.
- V1 capability scoping is not an OS sandbox. A role with `bash` still has operating-system access available to that process.
- Detached execution and automatic delayed resume after every same-tier provider is cooling down remain deferred in the internal backlog.

## Verification

```bash
npm run verify
npm pack --dry-run
```

The test suite includes configuration and model routing, schema/state transitions, idempotency and locks, private event/run recovery, linked-worktree identity, dirty-branch rejection, supervised terminal handoffs, integration-unit assembly, evidence checksums, and completion gates.
