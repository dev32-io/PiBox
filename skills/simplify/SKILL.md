---
name: simplify
description: Explicit /simplify command only. Review recent changes for reuse, quality, and efficiency, then apply justified cleanup.
disable-model-invocation: true
---

# Simplify

Run only when the user explicitly invokes `/simplify`, optionally followed by a focus such as `focus on memory efficiency`. Ordinary requests to simplify code do not activate this skill. This is a one-shot cleanup pass, not a persistent mode.

## Scope

- Read repository instructions and inspect `git status --short`, unstaged and staged diffs. Use `git diff HEAD` when HEAD exists; in an unborn repository inspect staged and unstaged changes separately. Include relevant untracked source files, never ignored files or secrets.
- Review these changes, not the whole repository. Read surrounding code and callers to understand behavior and find existing helpers.
- If there are no changes, report that and stop unless the user supplied an explicit commit, range, or paths. Outside Git, use files changed in this session or explicit user paths; ask for scope if unknown rather than guessing from modification times.
- Preserve existing work, public behavior, security checks, accessibility, and error handling. Do not stage, commit, reset, or change branches.
- Respect current mode, permissions, and approval requirements. This command does not authorize managed workflow execution or edits to workflow-owned resources; never race active workers.

## Three parallel reviews

Use `subagent_spawn` with `agent: code-reviewer` and `mode: background` for three independent, read-only reviews. Give each reviewer the same complete scoped diff (or a readable scratch file containing it), relevant untracked content, repository instructions, user focus, and these boundaries. Do not silently truncate the diff. Reviewers return concise actionable findings with file/line evidence and proposed fixes, not edits. Use configured default tiers.

1. **Reuse:** Find existing helpers or utilities that replace newly duplicated logic. Check whether reuse genuinely simplifies the code; do not invent abstractions for hypothetical reuse.
2. **Quality:** Check naming, clarity, redundant state, unnecessary nesting, leaky abstractions, stringly typed code, and over-engineering against repository conventions.
3. **Efficiency:** Find redundant computation or allocations, N+1 I/O, unnecessary rerenders, missed safe batching/concurrency, and resource leaks. Require concrete evidence; avoid speculative optimization.

Collect all three reports before editing. Continue independent work while reviewers run; use automatic completion delivery or `wait` with `event: subagent_settled` at a dependency barrier, never polling. If delegation is unavailable, perform the same three review passes locally and disclose that fallback. Failed reviews are incomplete, not clean results.

## Apply and verify

- Reconcile findings against current source, deduplicate, and discard false positives or low-value churn. Prefer deletion and existing helpers over new dependencies or abstractions.
- Apply small, justified, behavior-preserving fixes directly where current mode permits. For substantial refactoring, present a plan and obtain required approval first. Return material behavior, policy, security, or destructive decisions to the user.
- Run relevant checks and repository-required verification. Add or update a focused regression check for nontrivial logic changes. Inspect the final diff for unintended edits.
- Briefly report fixes, verification, and unresolved findings. If nothing warrants a change, say so. Do not manufacture cleanup.

## Provenance

PiBox adaptation of the publicly reconstructed [Simplify Skill description](https://github.com/noelzappy/claude-code-system-prompts/blob/main/prompts/19_simplify_skill.md), not an official or verbatim Anthropic system prompt.
