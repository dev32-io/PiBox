# PiBox Managed Workflow

PiBox combines a capable conversational orchestrator with a deterministic workflow harness. Models make product and engineering judgments; the harness enforces authored resource shapes, state ownership, Git isolation, scheduling, checks, review/fix loops, recovery, and permission gates.

The architecture contract is [`specs/agent-workflow.md`](specs/agent-workflow.md), and the conversational phase contract is [`agent-collaboration-flow.md`](agent-collaboration-flow.md).

## Load locally

```bash
pi --no-extensions \
  -e ./extensions/subagent/index.ts \
  -e ./extensions/workflow-runtime/index.ts \
  -e ./extensions/workflow/index.ts \
  -e ./extensions/work-mode/index.ts \
  --work-mode workflow \
  --theme ./themes/rattle.json
```

Workflow tools and commands are authorized only in [Workflow mode](work-modes.md). Initialize a repository with `/harness init [standard|economy]`. Repository policy lives in `.pi/harness.yaml`; tool permission policy lives in `.pi/permissions.yaml`. Initialization establishes a safe Git/develop boundary and the ignored `.worktree/` location without staging an existing project's files.

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
  evidence/        # retained legacy evidence, when present
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

The planner authors no evaluations, reports, handoffs, runtime repair tasks, or final outcome projections. Whole-branch review, stage reviewers/fixers, check repair, integration repair, and E2E/fix work are runtime-owned state slots. Execution initialization pins digests of the reviewed story, plan, and every task in `state.yaml`; authored mutations and digest drift are refused. This version has no topology or product-contract replan: those changes require explicit stop and a new target story. A factual execution defect may instead be corrected in runtime state at the current attention boundary, without rewriting the pinned authored YAML.

## Stage execution

The plan is an ordered stage train:

- **Sequential:** tasks run serially in one isolated stage workspace and each sees prior task commits; the barrier integrates the ordered contribution once.
- **Concurrent:** independent tasks run in per-task worktrees from one pinned base and cross one deterministic integration barrier.

Within a stage the runtime advances task implementation and task checks/repairs, integration, stage checks, and optional planned review/fix. Later stages wait. The persisted canonical feature/fix branch is checked at start, resume, and every canonical action; repair commits are serialized and validated against their pinned pre-repair head and protected paths. After all stages, runtime-owned whole-branch review inspects the exact execution-start-to-current diff, then final E2E exercises the story's complete journey contract.

Routine implementation, integration, verification, review, fix, re-review, final review, and E2E transitions advance automatically. The orchestrator returns only for contradictory authority, material product/policy/privacy/security/irreversible decisions, critical risk acceptance, unsafe/destructive recovery, unanswerable clarification, or exhausted configured retries. Do not poll while agents run.

Attention cannot be cleared by a plain resume. Each slot-level epoch persists one exact `attentionTarget`; legacy states without one deterministically select the first readable attention slot, while workflow-level attention remains targetless and cannot accept an execution correction. `workflow_control` with `request_changes` or `approve` records either a scoped change request or explicit rationales for every unresolved finding. Validation and corrected-check preflight precede mutation. If another concurrent slot still needs attention, the runtime then presents it with a fresh epoch/target and neither requests bypass nor resumes; otherwise the permission-bypass guard precedes fresh work. `request_changes.correction` must name the current `attentionEpoch` and exact target. Task corrections may override `description`, `scope`, `delivery`, or the complete `checks` array; stage-verification corrections may replace the complete verification `checks` array. Authoritative `repair_exhausted` integration, stage-review, final-review, or E2E attention accepts exact-target, genuinely new guidance for one fresh repair attempt. E2E `needs_user` attention also accepts this bounded correction when its repair count is already at or above the configured limit, its cause is absent or explicitly `needs_user`, and it retains no Critical findings. This permits newly approved prerequisite guidance without raising the budget, resetting counters, or relabeling the failure. Critical, unsafe, or unknown cause provenance does not qualify for this exception. Guidance cannot handle normal Critical attention or an exhaustion wrapper retaining a Critical finding, waive findings, or change story/E2E content, topology, dependencies, assignment, stage mode, or completed work.

`correctionSequence` is the monotonic correction count. `executionOverrides` materializes cumulative effective task/stage overrides and current slot guidance over the unchanged authored baseline; `executionCorrections` retains correction audit entries, prior repair counts, and failed-check evidence without age-based eviction. Previously compacted runs retain their effective overrides; discarded historical records are not reconstructed. Effective prose reaches repair workers and reviewers, and effective checks are the checks actually executed. A checks-only task correction reruns checks without reimplementation only when the runtime has both a validated contribution commit and preserved failed-check evidence; otherwise explicit implementation guidance is required. Check comparisons normalize generated IDs, string/object forms, commands, and default-profile semantics, so representation-only retries are no-ops. No-op, stale-epoch, wrong-boundary, malformed, or unpreflightable corrections are rejected before confirmation or mutation. Concurrent active attempts are durably fenced before corrected work resumes with fresh tokens. Routine factual correction within an already authorized outcome does not need a separate product checkpoint; material scope, policy, privacy/security, destructive/irreversible behavior, and Critical risk acceptance remain user-owned. Accepted findings remain visible as residual risks in `outcome.md`; `limits.repairRounds` is never reset or decremented.

A requested review fix that finishes successfully proceeds to an independent re-review. Each stage-review, whole-branch-review, and E2E loop retains its own verifier and distinct fixer conversation during the current activation. Compatible subsequent attempts continue those agents rather than restarting discovery. Re-review checks prior findings and repair regressions; E2E retesting still exercises the complete required contract. Actual contract, role, model, tool, or activation incompatibility can require a fresh agent. Previous Critical findings remain recorded until independent review resolves them; fixer completion does not accept risk or waive findings.

Standalone and managed E2E use the same `e2e_workspace` capability. It owns a private temporary workspace restored from the logical agent's session binding and retains separate report/evidence snapshots for successive evaluations. The tester keeps only useful sanitized evidence and finishes through the tool's structured report operation. Workflow records an exact workspace-report reference and consumes it; it does not copy, rename, or Git-publish these files. The fixer and Story Board read that same complete report and selected evidence outside disposable worktrees. There is no second terminal verdict JSON or model-maintained evidence manifest. Invalid arguments are corrected inside the evaluator attempt, not counted as product repairs. Workspace files survive agent/worktree teardown but `/tmp` retention is best effort; missing or invalid current proof is explicitly unavailable, never replaced by an older passing report. Existing canonical evidence remains readable for older runs. Normal stage/final reviewers retain their existing reporting interface.

Instructions, summaries, findings, corrections, and evidence references are preserved without arbitrary character or collection ceilings. Validation checks structure and authority, not display length. Previews and paged reads may be short without altering the stored content or failing execution.

Implementers and fixers submit useful non-obvious notes through append-only `workflow_ledger` before finishing. The tool queues complete content privately for parent-harness persistence after the current owned contribution validates; it does not edit canonical `ledger.yaml` from the child. Its acknowledgement distinguishes queued from persisted. Empty routine handoffs are unnecessary, repeated identical submissions are idempotent, and failed or stale attempts cannot publish notes. If persistence fails after contribution acceptance, state retains recoveries keyed by attempt token: `request_changes` retries a valid retained note; `approve` explicitly acknowledges a malformed optional note. These ledger-only controls neither accept Critical findings nor launch work. They preserve other pending attention and leave the workflow paused after the final note is resolved; a separate explicit resume uses the normal permission guard. Accepted code is never rerun just to repair ledger storage.

Fixers use stable per-loop workspace paths so conversation reuse does not require changing the continuation API. Each successful clean cycle can recreate its isolated workspace at the new canonical base. Dirty, invalid, unintegrated, or owner-lost work is preserved rather than forcibly removed or overwritten.

## State, ledger, and debug events

- **`state.yaml`** is the sole authority for scheduling, resume, active attempt ownership/tokens, retries, cumulative effective execution overrides, correction history, Git coordinates, outcome status, metrics, and lifecycle slots. Check failures may include bounded stdout/stderr head-and-tail diagnostics with explicit truncation; `causeCode` preserves the underlying cause through repair exhaustion.
- **`ledger.yaml`** is the curated rolling set of non-obvious agent findings and evidence. Entries are replaced or pruned semantically, never evicted by a fixed entry count. Only implementers/fixers receive the newest eight complete entries and canonical read-only ledger path in their initial system context. That seed stays fixed on continuation; ordinary file reads provide newer or additional entries. Reviewers and E2E evaluators receive neither ledger context nor ledger tools. Routine status, reviewer findings, and risk-acceptance decisions are not newly copied into this implementation ledger; review/risk authority remains in state and outcome.
- **`events.jsonl`** is coarse content-free debug/analytics logging. It records boundaries, durations, routes, usage, and compact result codes, but never prompts, outputs, finding bodies, reports, state patches, credentials, or user content.

One serialized workflow writer owns all three. Children never write them. State replacement is atomic and happens before a best-effort debug append. Startup never replays `events.jsonl`; state and metrics are never derived from it, and normal prompts, status, tools, and TUI rendering never include it. Only an explicit bounded filtered diagnostic read may expose debug events.

Timing has six exclusive categories: Implementation, Integration, Verification, Review, E2E, and **Repair**. Every fixer action uses Repair, including stage-review, whole-branch-review, and E2E fixes. Actual re-review/retesting keeps its original category. The clock is selected from owned active actions at durable activation, accepted settlement, and control boundaries—not by UI polling or worker-name inference. Repair has priority while any fixer is active; after the last fixer settles, remaining normal work resumes timing immediately. Concurrent workers never double-count wall time, and paused/attention states retain timing for still-active draining attempts. Existing runs load a missing Repair total as zero without guessing how to split their historical totals.

## Activation and recovery

Children belong to one activation. `/reload` is the only same-activation rebind path; the first explicit workflow demand after reload automatically recreates the runner and may reconnect to matching active attempts already held by the process-global `SubagentService`, with bounded current/terminal delivery and no file replay. Reload startup itself performs no workflow disk restoration.

Treat quit exactly like a process crash. Pi cannot guarantee graceful managed settlement during quit, so users should not quit while a workflow is running. Owner loss terminates child process groups, although the exact terminal event may be missing.

On the first explicit workflow demand in a later activation, before status, start, resume, control, or list inspection proceeds, the harness compares durable ownership, marks old running slots interrupted, fences their attempt tokens, pauses the workflow, preserves Git/worktrees, and marks incomplete timing. Ordinary startup performs no repository discovery, configuration loading, artifact enumeration, YAML parsing, or workflow disk restoration. It never adopts old processes, scans PIDs, tails files, uses heartbeat recovery, or replays debug events. An explicit resume launches fresh attempts only; if launching requires bypass, confirmation occurs first.

## Configuration

Tier profiles map semantic tiers to ordered concrete routes. Plans choose a tier; configuration chooses provider/model/effort. User defaults live in `~/.pi/agent/settings.json` under `modelTierListProfiles` (`PI_CODING_AGENT_DIR` overrides the directory). The tier-profile extension populates missing defaults on session startup; read-only workflow configuration loading never writes that file.

New repository scaffolds inherit those defaults. Define only intentional overrides in trusted repositories' `.pi/harness.yaml`: each same-name profile/tier route array replaces the global array, while omitted lists inherit. Explicit session profile selection wins over a repository `defaultProfile`, which wins over the global default. For example, override only `performance.medium` while configuring workflow limits:

```yaml
schemaVersion: 2

modelTierListProfiles:
  profiles:
    performance:
      medium: [openai-codex/gpt-5.6-sol#high]

limits:
  maxConcurrency: 4
  maxActiveSubagentsPerSession: 16
  protocolNudges: 1
  repairRounds: 2
```

Global `~/.pi/agent/harness/config.yaml` still supplies unrelated harness policy, but no longer supplies tier definitions. Move existing global tier customizations into `settings.json`; see [tier settings and migration](../extensions/model-tier-list-profiles/README.md). Project `.pi/settings.json` is not a tier-policy source.

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
