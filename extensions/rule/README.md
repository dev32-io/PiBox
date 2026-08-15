# Context rules

Loads repository instructions lazily using Claude Code-compatible `paths:` frontmatter.

## Locations

PiBox discovers Markdown rules recursively in this order:

1. `~/.claude/rules/`
2. `~/.pi/agent/rules/`
3. `<repository>/.claude/rules/`
4. `<repository>/.pi/rules/`

Later project rules therefore appear after user rules. Symlinked files and directories are supported, with cycle protection.

## Rule format

Rules without `paths` are included on every agent start:

```markdown
# Repository safety

Preserve unrelated work.
```

Rules with `paths` load after the agent reads a matching file:

```markdown
---
paths:
  - "gateway/**/*.ts"
  - "shared/**/*.{ts,tsx}"
---

# TypeScript conventions

Use strict types at public boundaries.
```

Patterns are matched against repository-relative paths and support Node's glob syntax, including `**` and brace alternatives. Invalid rules are skipped with a warning rather than treated as unconditional.

PiBox follows Claude Code's read-triggered behavior: it does not block or replay a first edit merely because the path would have activated a rule. Newly applicable bodies are attached to the matching read result for the next model inference and deduplicated until compaction. Reading a scoped rule directly also marks it loaded without duplicating its body.

## Transcript display

Automatic activation renders as a compact line such as:

```text
✓ Loaded 2 rules typescript, gateway/api
```

Direct reads of `SKILL.md` and files under `.claude/rules/` or `.pi/rules/` render as `Loaded skill …` or `Loaded rule …` instead of showing a collapsed content preview. Expanding the tool still reveals its full result.
