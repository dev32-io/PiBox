---
name: rule-writing
description: Write, revise, or review path-scoped rule files (`.pi/rules/`, `.claude/rules/`) and the `<topic>-details.md` docs they point to. Use when adding, promoting, or pruning a rule or its details doc. For AGENTS.md, CLAUDE.md, system prompts, and agent definitions use prompt-writing.
---

# Rule Writing

A rule file loads into context whenever a matching file is read, so it holds only instructions. Everything an agent needs to understand or apply a rule — reasons, observed behavior, examples, code pointers — goes in a details doc that the rule references and the agent reads only when needed. Write the two as a pair.

## Before writing

- Name the concrete behavior to produce or stop, ideally from an observed failure or user correction.
- Read what already loads for the same paths: `AGENTS.md`, other rules whose `paths:` overlap, and existing details docs for the topic. Extend or fix those instead of adding a near-duplicate; never restate an `AGENTS.md` boundary in a rule.
- Follow the repository's existing layout for rules and details docs. If none exists, ask before inventing one.

## Rule file

```markdown
---
paths:
  - "gateway/src/**/*.ts"
---
# <Area> guardrails

- <One instruction per bullet.>

When a rule is unclear, read `<path>/<topic>-details.md`.
```

- `paths:` globs match only the files where the rules apply. Split a rule out when only part of the tree needs it rather than widening the glob.
- Each bullet is one instruction an agent could be checked against: a trigger or subject plus the required action, with exact names, paths, commands, or thresholds. Write it in whatever grammar reads most clearly; a short qualifying clause is fine when it scopes the instruction.
- Leave out explanations, history, examples, code blocks, and descriptive facts about the system. If a bullet needs one of those to be followed correctly, put it in the details doc.
- Keep a file to a handful of bullets for one area. If deleting a bullet would not change likely behavior, delete it.
- End with one reference line listing the relevant details docs. Do not repeat the line per doc.

## Details doc

- Title it for the topic and open with one or two sentences of scope.
- Organize by the rules it supports. For each, give what an agent cannot infer from code: the reason, observed or counterintuitive behavior, the failure it prevents, and a pointer to the implementing code (`path` and symbol).
- Include an example or snippet only when it shows a shape that prose cannot.
- Record current truth. Drop superseded designs and branch history unless they explain a live trap.
- Stay short; a details doc is read on demand, not loaded always, but it is still read in full.

## Revising

Delete before adding. Remove bullets that are stale, obvious to a capable model, enforced by a linter or test, duplicated elsewhere, or explanation dressed as a rule; move their useful substance to the details doc. Keep rule and doc consistent in the same change.

## Finish

Show the full rule file and the details-doc diff, with bullet and line counts before and after.
