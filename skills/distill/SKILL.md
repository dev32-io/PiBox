---
name: distill
description: Use when distilling an explicit code, release, time, workflow, or session range into user-reviewed knowledge proposals.
---

# Distill

Facilitate a technical knowledge distillation. The deliverable is user-judged knowledge, not an autonomous memory write or a generic change summary.

## 1. Resolve the scope

Translate the user's request into `distill_prepare` parameters. Support explicit refs, tags, commits, dates, paths, work items, current-session inclusion, dirty-state inclusion, and focus. Do not infer a branch mutation, checkout, fetch, pull, or merge.

Show the returned target commit, baseline source and commit, time range, paths, work items, commit/file counts, dirty-state treatment, selected session IDs and entry range, raw-subagent mode, selected and available knowledge providers with locality, focus, and estimated partitions. Resolve material ambiguity with the user. Never select a remote knowledge provider without explicit user agreement. Do not call `distill_collect` until the user confirms that exact preview.

Analysis authorization is not authorization to edit guidance, documentation, rules, or memory.

## 2. Collect deterministic evidence

After scope confirmation, call `distill_collect` with the exact preview token. Read `scope.json`, `manifest.json`, and bounded slices of the relevant evidence artifacts through `distill_read`. When the target is not the checked-out commit, use `distill_read sourcePath=…` for target-tree verification and never treat the working checkout as the target.

Evidence priority is:

1. Target source and tests.
2. Git range evidence.
3. Reviewed workflow/task/review/evaluation/outcome artifacts.
4. Sanitized main-session context for ad hoc work.
5. Final subagent reports.
6. Targeted raw child sessions only for a concrete unresolved gap and only after telling the user why the drill-down is valuable.

Do not bulk-read raw subagent sessions. Workflow reports are the normal compression boundary.

## 3. Partition and delegate

Partition by coherent subsystem, workflow unit, or analysis focus. Launch bounded `knowledge-distiller` subagents with complete assignments containing:

- the confirmed scope;
- exact distillation run and artifact paths;
- assigned evidence slices;
- focus and stop conditions;
- the instruction-admission policy below;
- a prohibition on edits and mutations.

Run independent partitions in parallel where useful. Ask for targeted raw-session drill-down only when a report, failure event, or contradiction leaves one precise question unresolved.

Persist each returned report with `distill_record category=finding`. Subagents never write distillation artifacts directly.

## 4. Compare candidate knowledge

Reconcile reports against current target source. Deduplicate claims and preserve material disagreements. For retained candidate claims, call `distill_compare` so optional knowledge providers can return relevant existing memories or other knowledge. Continue normally when no provider is registered.

Classify each claim as new, confirming, narrowing, broadening, duplicate, contradictory, superseding, stale, or unresolved. Repository authority outranks reports and knowledge providers. Persist the comparison and synthesis with `distill_record`.

## 5. Apply the exceptional instruction gate

`AGENTS.md` and rule files are scarce always-loaded context. They contain pure instructions only.

Never recommend an example, explanation, history, summary, descriptive fact, subordinate clause, code block, or illustrative syntax for `AGENTS.md` or a rule. The proposed item must be one pure imperative sentence backed by tracked repository evidence. A candidate may enter `AGENTS.md` only when it is repository-wide, extremely critical, non-obvious to a capable model, repeatedly applicable, and materially dangerous or expensive to miss. A rule candidate must meet the same standard and have an exact path scope.

Prefer, in order:

1. no retained item;
2. distillation archive;
3. memory;
4. repository documentation;
5. scoped rule;
6. `AGENTS.md`.

For every possible instruction promotion, call `distill_instruction_check`. Present its exact current/additional/resulting character and estimated-token burden, percentage increase, deterministic rejection reasons, and the model judgment for criticality, non-obviousness, repeated applicability, and failure impact. A deterministic pass only makes the proposal eligible for user discussion; it does not approve it.

Recommend demotion or deletion when existing always-loaded guidance is descriptive, example-bearing, generic, obvious, stale, duplicated, overly broad, or not worth its measured context cost.

## 6. Discuss with the user

Conduct a technical discussion, not a bulk approval form. Present a compact overview, then discuss one coherent group of proposals at a time. For each item distinguish:

- observed evidence;
- distilled claim;
- comparison with retained knowledge;
- recommended destination or demotion;
- exact proposed wording when applicable;
- context burden for instruction destinations;
- uncertainty and alternatives.

The user may accept, reject, rewrite, narrow, change destination, defer, or request more evidence. Record each decision with `distill_record category=decision` and a stable finding-derived ID.

## 7. Apply only exact approvals

Do not mutate memory, guidance, rules, documentation, or source until the user explicitly approves the exact item, destination, wording, and scope. Use the destination's ordinary authoritative tool after approval. Never treat scope confirmation, report approval, or a general request to distill as mutation authorization.

After approved mutations, report what changed, what remained local to the distillation run, rejected/deferred items, measured guidance burden, and residual uncertainty.
