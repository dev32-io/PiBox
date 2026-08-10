# PiBox

PiBox is an original visual TUI package for the [Pi coding agent](https://github.com/badlogic/pi-mono). It provides the cool-steel `rattle` theme plus independent chat-input, status-bar, styled-output, spinner, and startup components.

The design and behavior contract lives in [`docs/specs/visual-tui.md`](docs/specs/visual-tui.md).

## Development

```bash
npm install
npm run verify
```

Local preview, without loading globally installed extensions:

```bash
pi --no-extensions \
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
