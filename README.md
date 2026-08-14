# PiBox

PiBox is a small extension pack for the [Pi coding agent](https://github.com/badlogic/pi-mono): a cool-steel TUI, useful provider integrations, sound feedback, and an optional managed workflow.

## Included

- **`rattle` theme** — cool-steel colors for Pi.
- **TUI extensions** — responsive status bar, refined chat input, compact tool previews/diffs, animated working status, and startup display.
- **`/effort`** — choose a reasoning effort supported by the active model; non-reasoning models safely use `off`.
- **Providers** — Ollama Cloud and custom OpenAI-compatible local endpoints.
- **Sound hooks** — optional completion feedback.
- **Workflow** — capability-backed planning, delegated worktrees, verification, and recovery. See [docs/workflow.md](docs/workflow.md).

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

## Workflow

```text
/harness init [standard|economy]
/workflow status

After reviewing a plan, say “start the workflow” to execute it.
```

See [docs/workflow.md](docs/workflow.md) for setup and behavior, and [docs/specs/visual-tui.md](docs/specs/visual-tui.md) for visual contracts.

## License

MIT
