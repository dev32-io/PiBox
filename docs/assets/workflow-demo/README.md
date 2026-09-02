# Workflow demo assets

Regenerate from the repository root:

```sh
python3 docs/assets/workflow-demo/render.py
```

Dependencies: Python 3, [Pillow](https://python-pillow.org/), `ffmpeg` on `PATH`, and scalable system sans, bold, monospace, and Unicode fonts. The renderer prefers installed Arial, Arial Bold, Menlo, and Arial Unicode faces where available, then falls back to Liberation or DejaVu families. No proprietary font files are bundled.

Outputs:

- `workflow-lifecycle.png` — high-resolution lifecycle chart.
- `workflow-demo-poster.png` — static opt-in preview for the animation.
- `workflow-demo.gif` — looping, accelerated workflow reenactment.

The renderer uses the Rattle palette and PiBox workflow dashboard vocabulary. The final product reveal comes from `aero-todo-product.png`, a sanitized real capture of the successful Aero Todo workflow result. The animation is an accelerated reenactment based on that real run; timing and terminal scenes are illustrative.

Rendering is deterministic for fixed inputs. Byte-identical output requires the same selected font files and Pillow and FFmpeg versions. Intermediate PNG frames and the generated GIF palette live under `.build/`; they are disposable, ignored, and replaced on every render.
