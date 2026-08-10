# PiBox

PiBox is a visual, feedback, provider, and workflow package for the [Pi coding agent](https://github.com/badlogic/pi-mono). It provides the cool-steel `rattle` theme; independent chat-input, status-bar, styled-output, spinner, and startup components; sound feedback hooks; `/login` integrations for Ollama Cloud and custom OpenAI-compatible endpoints; and a capability-backed development harness.

Design and behavior contracts:

- [`docs/specs/visual-tui.md`](docs/specs/visual-tui.md)
- [`docs/specs/feedback-hooks.md`](docs/specs/feedback-hooks.md)
- [`docs/specs/agent-harness.md`](docs/specs/agent-harness.md)

## Agent harness

The harness extension establishes canonical managed work items under `agent-artifacts/` and private append-only operational events under `~/.pi/agent/harness/`. Initial capabilities cover work-item creation, spec/design/decision artifact mutation, planning submission, direct user approval, configuration/model policy, and status inspection.

```text
/harness status
/harness approve <work-item-id>
```

Canonical mutations require a trusted, clean Git repository and create traceable commits. The remaining scheduler, supervised subagents, integration units, and recovery controls are being implemented against the harness specification.

## Sound feedback

The sound-hooks extension plays a user-supplied sound when `agent_settled` confirms that Pi has finished the complete agent loop. Copyrighted audio is not distributed. See [`extensions/feedback/sound-hooks/README.md`](extensions/feedback/sound-hooks/README.md) for local installation and configuration.

## Development

```bash
npm install
npm run verify
```

Local preview, without loading globally installed extensions:

```bash
pi --no-extensions \
  -e ./extensions/harness/index.ts \
  -e ./extensions/feedback/sound-hooks/index.ts \
  -e ./extensions/providers/ollama-cloud/index.ts \
  -e ./extensions/providers/local-llm/index.ts \
  -e ./extensions/tui/chat-input/index.ts \
  -e ./extensions/tui/status-bar/index.ts \
  -e ./extensions/tui/styled-outputs/index.ts \
  -e ./extensions/tui/spinners/index.ts \
  -e ./extensions/tui/startup/index.ts \
  --theme ./themes/rattle.json
```

The CLI flag makes `rattle` available for that run; select **rattle** from Pi's `/theme` menu to preview it. Do not save the selection if you want to leave the active Pi configuration unchanged.

PiBox does not provide provider-account quota or weekly usage metrics. Context occupancy comes from Pi's current-session context accounting.

## License

MIT
