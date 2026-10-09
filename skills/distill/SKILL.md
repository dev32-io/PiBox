---
name: distill
description: Use when distilling an explicit code, release, time, workflow, or session range into user-reviewed knowledge proposals.
---

# Distill

Facilitate a technical knowledge distillation. The deliverable is user-judged knowledge, not an autonomous memory write or a generic change summary.

## 1. Resolve the scope

Translate the request into `distill_prepare` parameters: explicit refs, tags, commits, dates, paths, work items, current-session inclusion, dirty-state inclusion, and focus. Do not branch-mutate, checkout, fetch, pull, or merge. Analysis authorization is not authorization to edit guidance, documentation, rules, or memory.

Show the returned target commit, baseline source and commit, time range, paths, work items, commit/file counts, dirty-state treatment, selected main-session IDs and entry range, selected and available knowledge providers with locality, focus, and estimated partitions. Resolve material ambiguity with the user. Select a remote knowledge provider only with explicit user agreement. Call `distill_collect` only after the user confirms that exact preview.

## 2. Collect deterministic evidence

Call `distill_collect` with the exact preview token. Read `scope.json`, `manifest.json`, and bounded slices of relevant evidence through `distill_read`. When the target is not the checked-out commit, verify with `distill_read sourcePath=…`; the working checkout is not the target.

Collected evidence is the complete sanitized selection. Use paged reads and coherent partitions for large files, sessions, or scope counts.

Evidence priority:

1. Target source and tests.
2. Git range evidence.
3. Reviewed story, plan, task, state, ledger, and outcome artifacts.
4. Sanitized selected main-session context for ad hoc work.

Child transcripts are not persisted for distillation. Use the workflow ledger and outcome as the compression boundary, not `.pibox/sessions` registries, child reports, evaluation reports, or raw child sessions.

## 3. Partition and delegate

Partition by coherent subsystem, workflow unit, or analysis focus. Launch bounded `knowledge-distiller` subagents, in parallel where useful, with complete assignments: confirmed scope, exact run and artifact paths, assigned evidence slices, focus and stop conditions, the instruction-admission policy below, and a prohibition on edits and mutations. For a precise evidence gap, state the limitation.

Persist each returned report with `distill_record category=finding`; subagents write no distillation artifacts.

## 4. Compare candidate knowledge

Reconcile reports against current target source. Deduplicate claims and preserve material disagreements. Call `distill_compare` for retained claims; continue if no provider is registered.

Classify each claim as new, confirming, narrowing, broadening, duplicate, contradictory, superseding, stale, or unresolved. Repository authority outranks reports and providers. Persist comparison and synthesis with `distill_record`.

## 5. Apply the exceptional instruction gate

`AGENTS.md` and rule files are scarce always-loaded context holding pure instructions only.

Propose for them only one pure imperative sentence backed by tracked repository evidence; no example, explanation, history, summary, descriptive fact, subordinate clause, code block, or illustrative syntax. A candidate may enter `AGENTS.md` only when repository-wide, extremely critical, non-obvious to a capable model, repeatedly applicable, and materially dangerous or expensive to miss. A rule candidate meets the same bar and has an exact path scope.

Prefer, in order:

1. no retained item;
2. distillation archive;
3. memory;
4. repository documentation;
5. scoped rule;
6. `AGENTS.md`.

For every possible instruction promotion, call `distill_instruction_check`. Present its current/additional/resulting character and estimated-token burden, percentage increase, rejection reasons, and your judgment of criticality, non-obviousness, repeated applicability, and failure impact. A deterministic pass makes the proposal eligible for discussion, not approved.

Recommend demotion or deletion of always-loaded guidance that is descriptive, example-bearing, generic, obvious, stale, duplicated, overly broad, or not worth its measured cost.

## 6. Discuss with the user

Give a compact overview, then discuss one coherent group of proposals at a time. For each item distinguish:

- observed evidence;
- distilled claim;
- comparison with retained knowledge;
- recommended destination or demotion;
- exact proposed wording when applicable;
- context burden for instruction destinations;
- uncertainty and alternatives.

The user may accept, reject, rewrite, narrow, change destination, defer, or request more evidence. Record each decision with `distill_record category=decision` and a stable finding-derived ID.

## 7. Apply only exact approvals

Mutate memory, guidance, rules, documentation, or source only after the user approves the exact item, destination, wording, and scope; scope confirmation, report approval, or a general request to distill is not that approval. Use the destination's ordinary authoritative tool.

Then report what changed, what remained local to the run, rejected/deferred items, measured guidance burden, and residual uncertainty.
