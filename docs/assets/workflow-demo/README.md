# Workflow demo assets

The lifecycle chart and terminal recording use separate pipelines.

## Lifecycle chart

Regenerate from the repository root:

```sh
python3 docs/assets/workflow-demo/render.py
```

This requires Python 3, [Pillow](https://python-pillow.org/), and scalable system sans, bold, monospace, and Unicode fonts. The renderer prefers installed Arial, Arial Bold, Menlo, and Arial Unicode faces, then Liberation or DejaVu families. It writes `workflow-lifecycle.png`; byte-identical output requires the same selected fonts and Pillow version.

## Real Pi TUI recording

The committed animation is not a Pillow-drawn terminal. `capture.tape` starts a fixed-size, isolated Pi PTY, types the opening idea as real terminal input, and records pixels rendered by Pi with the Rattle theme. `capture.ts` is a capture-only extension: it renders the discussion and authoring transitions with Pi TUI components, then feeds representative reconstructed states through the production `workflowDashboardLines` renderer. Exact topology, review-repair outcomes, final metrics, checks, and E2E totals come from the committed sanitized `run6-provenance.json`; intermediate timing is illustrative.

Requirements:

- Pi 0.84.4 from this repository's supported toolchain;
- [VHS](https://github.com/charmbracelet/vhs) **v0.11.0**, supplied with `VHS_BIN` or on `PATH`;
- [ttyd](https://github.com/tsl0922/ttyd) **1.7.7** on `PATH` (a documented VHS runtime dependency; `record.py` verifies the version);
- FFmpeg 8.1.2 or a compatible release on `PATH`;
- Menlo, or an intentionally reviewed replacement configured in `capture.tape`.

Record and assemble from the repository root:

```sh
VHS_BIN=/path/to/vhs-v0.11.0 python3 docs/assets/workflow-demo/record.py
```

`record.py` verifies the VHS version, creates disposable quiet-startup Pi settings under `/tmp`, records `workflow-tui-raw.mp4`, and uses FFmpeg for only the one-second dashboard zoom, timing, real-product crossfade, GIF encoding, and poster extraction. Raw video and other intermediates remain under ignored `.build/`.

Outputs:

- `workflow-lifecycle.png` — high-resolution lifecycle chart.
- `workflow-demo-poster.png` — static opt-in preview extracted from the real terminal recording.
- `workflow-demo.gif` — looping, accelerated real-Pi-TUI recording.

The final reveal uses `aero-todo-product.png`, a sanitized real capture of the Aero Todo application delivered by the completed workflow. The animation visibly preserves the run's 1/6/5/1 task topology, two review repairs, 13/13 completion, 62/62 checks, exact final metrics, and 5/5 E2E result without claiming original intermediate timing. The checked-in media was recorded against PiBox parent commit `79dee268ac2f24ef797d4fb8308b08ef32b4ce27`; the production dashboard source was unchanged by this media-only follow-up. Recorder output can vary with terminal fonts and platform rendering, so regenerate only with an intentionally reviewed capture toolchain.
