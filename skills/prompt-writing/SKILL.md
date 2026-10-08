---
name: prompt-writing
description: Write, rewrite, shorten, or review standing agent instructions — system and mode prompts, agent definitions, AGENTS.md, CLAUDE.md, and path-scoped rule files. Use when creating or editing these files or when an agent keeps ignoring or drifting from them. Not for subagent briefs or task prompts written while delegating work, and not for authoring SKILL.md files (use skill-creator).
---

# Prompt Writing

Standing instructions load into every turn, so each line costs attention and competes with every other rule. The goal is the smallest set of instructions that produces the intended behavior. Left unguided, agents write these files as explanation; write them as rules whose effect is observable.

## Start from behavior

Before writing, name the target surface and the concrete behavior to produce or stop. Prefer an observed failure (transcript, user correction, repeated mistake) over an imagined one. If none exists and the request is a new file, state the few behaviors that matter most and stop there.

Read what already loads alongside the target: the base or harness system prompt, tool descriptions, repository instructions, and skills that cover the same ground. Never restate them; conflicting or duplicated rules make the model pick arbitrarily or stall.

## Delete first

When revising, cut before adding. Remove:

- Content the agent can discover itself: directory layouts, code style a linter or the existing code enforces, generic engineering advice.
- Rules already stated by the harness, tools, or another loaded instruction.
- Motivation paragraphs and "use heavily"-style intensity. Keep a reason only as a short clause when it changes how the rule generalizes.
- Eager or absolute wording ("actively", "proactively", "always", "CRITICAL", caps) unless guarding a genuine invariant. Current models over-apply it.
- Rules for failures the model no longer has, and examples that only restate a rule.

Test each remaining line: if deleting it would not change likely behavior, delete it.

## Write rules that can be checked

- State a trigger and an action: "Before teaching a topic, `recall` with the topic name," not "use memory actively."
- Name exact commands, paths, tools, and thresholds.
- Say what to do rather than what to avoid, unless the prohibition is the point.
- Each rule appears once, in the one place that owns it.
- One concrete example beats a list of edge cases; add one only when format or tone is the point.

## Surface notes

**System and mode prompts.** Control scope and stopping, which models get wrong over long tasks. State what approval covers, when to re-read the plan or state file, where new scope goes instead of being executed, and when verification is done. Leave tool mechanics to the tool descriptions.

**Agent definitions.** Define the role's output and authority boundaries. The parent's brief supplies the task; do not prescribe method the agent can choose itself.

**AGENTS.md / CLAUDE.md.** Only universally applicable, non-inferable facts: exact build/test/verify commands, costly traps, boundaries, and where authoritative docs live (point, don't copy). Keep it well under 200 lines. Move instructions that apply to part of the tree into path-scoped rules (`.pi/rules/` or `.claude/rules/` with `paths:` frontmatter). When `distill_instruction_check` is available, run it on a proposed unconditional addition.

## Finish

Report word or line counts before and after, and show the diff or full text for review. Do not add tests that pin prompt wording; behavior is the real test, so suggest one realistic run that would show whether the change worked.
