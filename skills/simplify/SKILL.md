---
name: simplify
description: Explicit /simplify command only. Review recent changes for reuse, quality, and efficiency, then apply justified cleanup.
disable-model-invocation: true
---

# Simplify

Run only when the user explicitly invokes `/simplify`, optionally followed by a focus such as `focus on memory efficiency`. Ordinary requests to simplify code do not activate this skill. This is a one-shot cleanup pass, not a persistent mode.

## Scope

- Read repository instructions and inspect `git status --short` and staged and unstaged diffs (`git diff HEAD` when HEAD exists; otherwise each separately). Include relevant untracked source files, never ignored files or secrets.
- Review these changes, not the whole repository. Read surrounding code and callers to understand behavior and find existing helpers.
- If there are no changes, report that and stop unless the user supplied a commit, range, or paths. Outside Git, use files changed in this session or user paths; ask for scope if unknown.
- Preserve existing work, public behavior, security checks, accessibility, and error handling. Do not stage, commit, reset, or change branches.
- Respect current mode, permissions, and approvals. This command does not authorize managed workflow execution or edits to workflow-owned resources; do not race active workers.

## Three parallel reviews

Use `subagent_spawn` with `agent: code-reviewer` and `mode: background` for three independent, read-only reviews at configured default tiers. Give each the same complete scoped diff (or a readable scratch file containing it), relevant untracked content, repository instructions, user focus, and its lens. Do not truncate the diff. Reviewers return concise findings with file/line evidence and proposed fixes, not edits.

1. **Reuse:** Existing helpers that replace newly duplicated logic, only where reuse genuinely simplifies; no abstractions for hypothetical reuse.
2. **Quality:** Naming, clarity, redundant state, unnecessary nesting, leaky abstractions, stringly typed code, and over-engineering against repository conventions.
3. **Efficiency:** Redundant computation or allocations, N+1 I/O, unnecessary rerenders, missed safe batching/concurrency, and resource leaks, with concrete evidence.

Collect all three reports before editing. If delegation is unavailable, run the three passes locally and disclose that. A failed review is incomplete, not clean.

## Apply and verify

- Reconcile findings against current source, deduplicate, and discard false positives and low-value churn. Prefer deletion and existing helpers over new dependencies or abstractions.
- Apply small, justified, behavior-preserving fixes directly where current mode permits. For substantial refactoring, present a plan and obtain required approval. Return material behavior, policy, security, or destructive decisions to the user.
- Run relevant checks and repository-required verification. Add or update a focused regression check for nontrivial logic changes. Inspect the final diff for unintended edits.
- Briefly report fixes, verification, and unresolved findings. If nothing warrants a change, say so; do not manufacture cleanup.

## Provenance

PiBox adaptation of the publicly reconstructed [Simplify Skill description](https://github.com/noelzappy/claude-code-system-prompts/blob/main/prompts/19_simplify_skill.md), not an official Anthropic prompt.
