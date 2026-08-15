# PiBox

PiBox is a small extension pack for the [Pi coding agent](https://github.com/badlogic/pi-mono): a cool-steel TUI, useful provider integrations, sound feedback, and an optional managed workflow.

## Included

- **`rattle` theme** — cool-steel colors for Pi.
- **TUI extensions** — responsive status bar, refined chat input, compact tool previews/diffs, animated working status, and startup display.
- **`/effort`** — choose a reasoning effort supported by the active model; non-reasoning models safely use `off`.
- **Providers** — Ollama Cloud and custom OpenAI-compatible local endpoints.
- **Sound hooks** — optional response, workflow task-completion, and workflow-attention feedback using user-supplied audio.
- **Context rules** — Claude-compatible path-scoped instructions loaded only after matching files are read, from `.claude/rules/` or `.pi/rules/`.
- **Workflow** — collaborative story shaping, capability-backed delivery planning, delegated worktrees, runtime-owned final verification, and recovery. See [docs/workflow.md](docs/workflow.md).
- **Architecture visualizer skill** — agent-authored JSON rendered as a live, interactive local browser diagram with deterministic automatic layouts.

## Install and verify

```bash
npm install
npm run verify
```

Pi loads the package extensions listed in `package.json`. For a local preview without globally configured extensions:

```bash
pi --no-extensions \
  -e ./extensions/tui/chat-input/index.ts \
  -e ./extensions/tui/effort/index.ts \
  -e ./extensions/tui/status-bar/index.ts \
  -e ./extensions/tui/styled-outputs/index.ts \
  -e ./extensions/tui/spinners/index.ts \
  -e ./extensions/tui/startup/index.ts \
  --theme ./themes/rattle.json
```

## Effort defaults

The default is `medium`; unsupported levels are safely clamped for each model. User configuration loads first and repository configuration overrides it:

- `~/.pi/agent/pibox/effort.yaml`
- `.pi/pibox-effort.yaml`

```yaml
default: medium
models:
  openai-codex/gpt-5.6-luna: high
```

Use `/effort` to select a compatible level interactively, or `/effort high` directly.

## Context rules

Rules without `paths:` frontmatter apply on every agent start. Scoped rules load after the agent reads a matching file, avoiding an up-front dump of unrelated instructions:

```markdown
---
paths: ["src/**/*.ts"]
---

# TypeScript rules

Use strict types at public boundaries.
```

Project rules live under `.claude/rules/` or `.pi/rules/`; user rules live under `~/.claude/rules/` or `~/.pi/agent/rules/`. Rule and skill reads use compact `Loaded …` transcript rows. See [extensions/rule/README.md](extensions/rule/README.md).

## Architecture visualizer

Invoke `/skill:architecture-visualizer` to explore a codebase and create a live visual explanation. The skill writes a flexible JSON document while its local renderer owns layout, grouping, arrows, and interaction. The `visual_companion` tool starts or stops one random-port loopback backend per Pi session; updating the JSON during later conversation automatically refreshes the open page. Future visualizers can register with the same backend.

## Sound feedback

The default EVE Online manifest maps three feedback boundaries:

- Pi response settled;
- managed workflow task contribution completed;
- managed workflow paused for failure or user/orchestrator attention.

Audio is not distributed with PiBox. Install user-supplied files under `~/.pi/agent/pibox/sounds/eve-online/`; see [extensions/feedback/sound-hooks/README.md](extensions/feedback/sound-hooks/README.md) for filenames, configuration, and the local-copy example. Copyrighted media must remain untracked.

## Workflow

```text
/harness init [standard|economy]
/workflow status

Discuss and shape the story, review the persisted story, then create and review the delivery plan.
After reviewing the plan, say “start the workflow” to execute it.
```

Task tickets are self-contained; `task_clarify` is an exceptional targeted context lookup. For ad hoc delegation, `general-purpose` handles open-ended bounded research, implementation, and verification with broad repository tools but no recursive subagent controls; specialized definitions remain available for exploration, review, and managed execution. Agent-definition frontmatter is the sole tool allowlist authority; `harness.yaml` tool lists are ignored. Its `tools` field may also contain optional `mcp:<server>` selectors backed by the independently installed `pi-mcp-adapter`: missing servers are ignored, while launched children scope the adapter proxy to only the declared server names. Built-ins grant Playwright to `e2e-tester`, Playwright and Context7 to `general-purpose`, and Context7 to `implementer`. Delivery plans may add focused evaluations, while the runtime owns final whole-branch journey verification and final branch review. Existing legacy final-E2E coverage is adopted rather than duplicated.

MCP transport and updates remain user-owned. Install `pi-mcp-adapter` separately and register server names such as `playwright` and `context7` in its standard `mcp.json`; PiBox does not bundle MCP clients or server versions.

See [docs/workflow.md](docs/workflow.md) for setup and behavior, and [docs/specs/visual-tui.md](docs/specs/visual-tui.md) for visual contracts.

### Workflow execution benchmark

```bash
npm run eval:workflow                 # deterministic CI-grade scenarios
npm run eval:workflow:model           # opt-in Luna model scenarios
npm run eval:workflow:compare         # compare with the reviewed baseline
```

The benchmark covers scheduling, Git safety, review/repair, recovery, clarification, protocol, and completion. Reports are written beneath ignored `.benchmark/`; reviewed baselines and retained findings live in `benchmarks/workflow-execution/`. See [docs/workflow-execution-eval.md](docs/workflow-execution-eval.md).

## License

MIT
