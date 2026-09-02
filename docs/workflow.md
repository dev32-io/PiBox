# PiBox Managed Workflow

PiBox combines a capable conversational orchestrator with a deterministic workflow harness. Models make product and engineering judgments; the harness enforces authored resource shapes, state ownership, Git isolation, scheduling, checks, review/fix loops, recovery, and permission gates.

The architecture contract is [`specs/agent-workflow.md`](specs/agent-workflow.md), and the conversational phase contract is [`agent-collaboration-flow.md`](agent-collaboration-flow.md).

## Load locally

```bash
pi --no-extensions \
  -e ./extensions/subagent/index.ts \
  -e ./extensions/workflow-runtime/index.ts \
  -e ./extensions/workflow/index.ts \
  --theme ./themes/rattle.json
```

Initialize a repository with `/harness init [standard|economy]`. Repository policy lives in `.pi/harness.yaml`; tool permission policy lives in `.pi/permissions.yaml`. Initialization establishes a safe Git/develop boundary and the ignored `.worktree/` location without staging an existing project's files.

## Collaboration and authorization

```text
free-form discussion
  → shape structured Markdown story and per-case E2E
  → persist, compile, and stop for explicit story review
  → author, compile, and review a separate delivery plan
  → explicit user request to start or resume
  → extension-owned bypass confirmation
  → managed execution and outcome
```

Clear local reversible work may remain ad hoc. The first persisted story is always handed back for user review before delivery planning; even an original end-to-end planning request does not skip this gate. Planning is a separate review boundary and never authorizes execution.

A clear user request to start or resume is the sole execution gate. `workflow_start`, and any resume that would launch children while the current session is not already in bypass mode, presents an extension-owned permission confirmation after side-effect-free preflight and before child launch. Critical-risk approval always presents a separate explicit user confirmation, even in bypass mode. Cancellation launches nothing and does not mutate execution or permission state. Bypass skips only repository tool permission checks; Git isolation, workflow authority, reviews, verification, and recovery remain enforced.

## Authored resources

New stories use one small canonical directory:

```text
agent-artifacts/<story>/
  story.yaml
  plan.yaml
  tasks/<task>.yaml
  state.yaml       # runtime-owned, Git-ignored
  ledger.yaml      # runtime-owned, Git-ignored
  events.jsonl     # runtime-owned, Git-ignored
  outcome.md
  evidence/        # only intentionally retained sanitized evidence
```

`story.yaml` stores identity and three Markdown-rich rendered fields with a compact required structure:

```yaml
schemaVersion: 1
id: checkout
title: Reliable checkout
kind: story
spec: |
  # Spec

  ## Outcome

  A valid checkout creates exactly one order.

  ## Scope

  Checkout submission, excluding settlement.

  ## Behavior

  Valid input creates one order; invalid input creates none.

  ## Acceptance

  Success and typed rejection are externally observable.
design: |
  # Design

  ## Approach

  Route submission through the existing checkout command.

  ## Boundaries and Flow

  The UI calls the command and renders its typed result.

  ## Failure and Verification

  Rejection does not persist; focused tests prove both paths.
e2e: |
  # E2E

  ## Scope

  The disposable checkout journey.

  ## E2E-001 — Complete checkout

  ### Exercise

  Submit a disposable valid cart.

  ### Oracle

  One confirmation identifies one order.

  ### Proof

  Capture the confirmation and disposable order, then clean up.
```

The main orchestrator uses flat writers and never writes raw YAML. Creation supplies each resource's required fields; ref-addressed updates omit unchanged scalar fields, while `dependsOn`, `checks`, and stage `tasks` replace their complete arrays. Story specification requires Outcome, Scope, Behavior, and Acceptance; design requires Approach, Boundaries and Flow, and Failure and Verification; each stable `E2E-NNN` case requires Exercise, Oracle, and Proof. The renderer reserves level-two headings, so field-local structure uses lists, tables, bold labels, or lower-level headings. Authoring requires a clean repository with a valid `HEAD` on `develop` or the story's feature/fix branch; flat writers own target-branch creation and harness commits.

`plan.yaml` contains ordered execution stages. `task_write` and `stage_write` edit one flat resource at a time; incomplete dependencies or membership may remain during drafting. Near-zero-argument `workflow_compile` reads the current branch and aggregates structural and topology errors before story or plan review. Compilation changes nothing, carries no authored payload, and never authorizes planning or execution. Each stage explicitly runs its task set `sequential` or `concurrent`, declares deterministic checks, and may add `review.mode` (`required` or `skip`) plus free-form `review.focus`. It never stores repair-round counts; `.pi/harness.yaml` `limits.repairRounds` is the sole retry-limit authority.

Each `tasks/<task>.yaml` is one concise context capsule:

```yaml
schemaVersion: 1
id: submit-checkout
title: Submit checkout
dependsOn: []
description: Connect checkout submission through the existing command boundary.
scope: Own the command adapter and focused tests; exclude payment settlement.
delivery: Preserve typed failures, create one order on success, and leave a clean verified contribution.
checks:
  - npm test -- checkout-command
assignment:
  agent: implementer
  tier: medium
  rationale: A bounded implementation at an existing seam.
```

Outside the structural parent field, task prose contains no story/artifact references or narrative taxonomy. Workers receive complete `description`, `scope`, and `delivery` in persistent system context. Checks stay harness-owned. `task_clarify` searches or reads bounded line ranges from story `spec` or `design` when a concrete uncertainty remains. Final E2E actors receive `e2e` directly.

The planner authors no evaluations, reports, handoffs, runtime repair tasks, or final outcome projections. Whole-branch review, stage reviewers/fixers, check repair, integration repair, and E2E/fix work are runtime-owned state slots. Execution initialization pins digests of the reviewed story, plan, and every task in `state.yaml`; authored mutations and digest drift are refused. This version has no in-place replan: a contract change requires explicit stop and a new target story.

## Stage execution

The plan is an ordered stage train:

- **Sequential:** tasks run serially in one isolated stage workspace and each sees prior task commits; the barrier integrates the ordered contribution once.
- **Concurrent:** independent tasks run in per-task worktrees from one pinned base and cross one deterministic integration barrier.

Within a stage the runtime advances task implementation and task checks/repairs, integration, stage checks, and optional planned review/fix. Later stages wait. The persisted canonical feature/fix branch is checked at start, resume, and every canonical action; repair commits are serialized and validated against their pinned pre-repair head and protected paths. After all stages, runtime-owned whole-branch review inspects the exact execution-start-to-current diff, then final E2E exercises the story's complete journey contract.

Routine implementation, integration, verification, review, fix, re-review, final review, and E2E transitions advance automatically. The orchestrator returns only for contradictory authority, material product/policy/privacy/security/irreversible decisions, critical risk acceptance, unsafe/destructive recovery, unanswerable clarification, or exhausted configured retries. Do not poll while agents run.

Attention cannot be cleared by a plain resume. `workflow_control` with `request_changes` or `approve` records either a bounded change request or explicit rationales for every unresolved finding, passes through the same preflight and permission-bypass guard, and then resumes fresh work. Accepted findings remain visible as residual risks in `outcome.md`; repair exhaustion remains controlled only by `limits.repairRounds`.

## State, ledger, and debug events

- **`state.yaml`** is the sole authority for scheduling, resume, active attempt ownership/tokens, retries, Git coordinates, outcome status, metrics, and lifecycle slots.
- **`ledger.yaml`** is a small rewritten set of currently relevant non-obvious agent findings and evidence. It is the only rolling handoff context. Routine status and scheduler events never enter it.
- **`events.jsonl`** is coarse content-free debug/analytics logging. It records boundaries, durations, routes, usage, and compact result codes, but never prompts, outputs, finding bodies, reports, state patches, credentials, or user content.

One serialized workflow writer owns all three. Children never write them. State replacement is atomic and happens before a best-effort debug append. Startup never replays `events.jsonl`; state and metrics are never derived from it, and normal prompts, status, tools, and TUI rendering never include it. Only an explicit bounded filtered diagnostic read may expose debug events.

## Activation and recovery

Children belong to one activation. `/reload` is the only same-activation rebind path; the first explicit workflow demand after reload automatically recreates the runner and may reconnect to matching active attempts already held by the process-global `SubagentService`, with bounded current/terminal delivery and no file replay. Reload startup itself performs no workflow disk restoration.

Treat quit exactly like a process crash. Pi cannot guarantee graceful managed settlement during quit, so users should not quit while a workflow is running. Owner loss terminates child process groups, although the exact terminal event may be missing.

On the first explicit workflow demand in a later activation, before status, start, resume, control, or list inspection proceeds, the harness compares durable ownership, marks old running slots interrupted, fences their attempt tokens, pauses the workflow, preserves Git/worktrees, and marks incomplete timing. Ordinary startup performs no repository discovery, configuration loading, artifact enumeration, YAML parsing, or workflow disk restoration. It never adopts old processes, scans PIDs, tails files, uses heartbeat recovery, or replays debug events. An explicit resume launches fresh attempts only; if launching requires bypass, confirmation occurs first.

## Configuration

Tier profiles map semantic tiers to ordered concrete routes. Plans choose a tier; configuration chooses provider/model/effort:

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
      local: [local-llm/example#medium]

limits:
  maxConcurrency: 4
  maxActiveSubagentsPerSession: 16
  protocolNudges: 1
  repairRounds: 2
```

Agent-definition Markdown frontmatter is the sole base tool allowlist. Optional `mcp:<server>` selectors use the independently configured `pi-mcp-adapter`; absent servers degrade gracefully.

## Completion and safety

Completion produces one `outcome.md` with delivered behavior, checks, review/E2E results, deviations, and residual risk. The branch remains ready for the user's normal merge/PR process; PiBox does not switch or merge it for the user.

The harness never auto-stashes, resets, discards dirty work, invisibly resolves integration conflicts, or executes legacy workflow state as current state. Historical `agent-artifacts` remain immutable history. V1 capability scoping is not an OS sandbox: a child with `bash` retains operating-system access.

## Verification

```bash
npm run verify
npm pack --dry-run
```

For deterministic workflow scenarios, run `npm run eval:workflow`; model scenarios are opt-in.
