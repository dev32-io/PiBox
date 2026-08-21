# PiBox

PiBox is a small extension pack for the [Pi coding agent](https://github.com/badlogic/pi-mono): a cool-steel TUI, useful provider integrations, sound feedback, and an optional managed workflow.

## Included

- **`rattle` theme** — cool-steel colors for Pi.
- **TUI extensions** — responsive status bar, refined chat input with a clickable fullscreen return-to-bottom action, compact tool previews/diffs, animated working status, and startup display.
- **Repository permissions** — Claude Code-style `.pi/permissions.yaml` rules with enforced/bypass modes, inherited child state, and `Shift+Tab` switching.
- **`/effort`** — choose a reasoning effort supported by the active model; local-LLM endpoints expose `off`, `low`, `medium`, `high`, and `xhigh`, using the configured default unless explicitly overridden.
- **Providers** — Ollama Cloud and custom OpenAI-compatible local endpoints, variable Codex subscription-usage status, and transparent same-tier provider fallback for spawned agents.
- **Sound hooks** — optional response, workflow task-completion, and workflow-attention feedback using user-supplied audio.
- **Context rules** — Claude-compatible path-scoped instructions loaded only after matching files are read, from `.claude/rules/` or `.pi/rules/`.
- **Workflow** — collaborative story shaping, capability-backed delivery planning, delegated worktrees, runtime-owned final verification, and recovery. See [docs/workflow.md](docs/workflow.md).
- **Architecture visualizer skill** — agent-authored JSON rendered as a live, interactive local browser diagram with deterministic automatic layouts.
- **Local service adapter** — lazy, health-checked lifecycle management for shared Mem0 and SearXNG services plus the session-scoped visual companion.
- **Repository memory** — explicit curated Mem0 writes, bounded recall, and an advisory `/memory-audit` with no silent mutation.
- **Knowledge distillation** — `/distill` resolves arbitrary code/time/workflow/session ranges into local evidence packets and user-reviewed promotion or demotion proposals without depending on one memory backend.

## Install and verify

```bash
npm install
npm run verify
```

Pi loads the package extensions listed in `package.json`. For a local preview without globally configured extensions:

```bash
pi --no-extensions \
  -e ./extensions/permissions/index.ts \
  -e ./extensions/tui/chat-input/index.ts \
  -e ./extensions/tui/effort/index.ts \
  -e ./extensions/tui/status-bar/index.ts \
  -e ./extensions/tui/styled-outputs/index.ts \
  -e ./extensions/tui/spinners/index.ts \
  -e ./extensions/tui/startup/index.ts \
  --theme ./themes/rattle.json
```

## Effort defaults

PiBox preserves Pi's resolved effort from global settings, CLI flags, or session restoration unless an explicit PiBox override is configured. Unsupported explicit overrides are safely clamped for each model. User configuration loads first and repository configuration overrides it:

- `~/.pi/agent/pibox/effort.yaml`
- `.pi/pibox-effort.yaml`

```yaml
default: medium
models:
  openai-codex/gpt-5.6-luna: high
```

Use `/effort` to select a compatible level interactively, or `/effort high` directly. A per-model entry overrides the optional shared PiBox default. PiBox uses `Shift+Tab` for permission mode instead of effort cycling; set `"app.thinking.cycle": []` in `~/.pi/agent/keybindings.json` to remove Pi's stock binding.

## Provider capacity and usage

Spawned agents traverse the ordered, usable routes in their selected `modelTiers` entry. Rate/subscription limits, authentication failures, exhausted provider retries, and bounded transport/server failures place the failed provider on cooldown and transparently continue with the next same-tier provider. Foreground calls remain pending; failed intermediate output is not sent to the main session. Strict concrete-model requests never fall back, and context, cancellation, protocol, tool, or implementation failures do not trigger a provider change.

When the active `openai-codex` model uses OAuth subscription authentication, PiBox reads the account's variable rate-limit windows and appends concise percentage/reset information after the existing context gauge. Zero, one, or multiple windows are supported; the entire appended area is hidden when reliable usage is unavailable or does not fit. Ollama Cloud currently exposes no reliable account-quota API, so its integration records `429`/`Retry-After` capacity signals without displaying fabricated quota percentages.

## Repository permissions

Repository policy lives at `.pi/permissions.yaml` and supports `allow`, `ask`, and `deny` decisions for file, Bash, MCP, and extension tools. Restrictive matches win. Enforced mode prompts only in the interactive TUI and denies unattended asks; bypass permits tools without evaluating the repository tool permission policy. `Shift+Tab` and `/permissions` switch the session-scoped mode, and every spawned PiBox child inherits its parent's mode.

Managed workflows require bypass. `workflow_start` shows an extension-owned confirmation before preparation and switches to bypass only after successful preparation and snapshot validation. The permission bypass does not bypass PiBox workflow authority, Git isolation, reviews, or verification. See [extensions/permissions/README.md](extensions/permissions/README.md).

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

## Local services and memory

`/services` reports the machine-scoped Mem0 and SearXNG services alongside the session-scoped visual companion. Services start lazily, use independent health probes, and never update during startup. `/memory-start`, `/memory-stop`, and `/memory-status` manage Mem0 directly; automatic recall injects scored repository memories ephemerally into main-agent and spawned-subagent runs; `/memory-debug` explains the latest selection; and `/memory-audit` performs bounded advisory review without changing records. See [extensions/service-adapter/README.md](extensions/service-adapter/README.md) and [extensions/memory-adapter/README.md](extensions/memory-adapter/README.md).

## Knowledge distillation

`/distill` previews an exact immutable scope before collecting bounded Git, workflow, guidance, session, and subagent-report evidence under ignored `.pibox/distill/`. Dedicated read-only distillers produce proposals; optional providers such as Mem0 support claim comparison; instruction promotion is exceptional, example-free, and measured for always-loaded context cost. See [extensions/distill/README.md](extensions/distill/README.md).

## Architecture visualizer

Invoke `/skill:architecture-visualizer` to explore a codebase and create a live visual explanation. The skill writes a flexible JSON document while its local renderer owns layout, grouping, arrows, and interaction. The `visual_companion` tool starts or stops one random-port loopback backend per Pi session; updating the JSON during later conversation automatically refreshes the open page. Session shutdown closes the in-process server, and its listener/watchers are unreferenced so they cannot keep Pi alive after an abrupt quit. The footer includes it in the compact service row, using a neutral dim `○` while intentionally stopped.

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
