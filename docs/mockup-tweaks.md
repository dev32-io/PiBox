# Mockup tweaks

Visual Companion shows an optional compact **Tweaks** panel below a mockup. Put `tweaks.json` beside mockup `index.html`. Mockups without this file render unchanged.

```json
{
  "controls": [
    {
      "key": "layout",
      "label": "Layout",
      "type": "choice",
      "options": [
        { "value": "cards", "label": "Cards" },
        { "value": "table", "label": "Table" }
      ],
      "default": "cards"
    },
    { "key": "motion", "label": "Motion", "type": "toggle", "default": true },
    { "key": "density", "label": "Density", "type": "range", "min": 1, "max": 5, "step": 1, "default": 3 }
  ]
}
```

Keys must be unique stable identifiers matching `[A-Za-z][A-Za-z0-9_-]*`. Choice values are strings. Toggle defaults are booleans. Range values are finite numbers within `min` and `max`. JSON contains metadata only: no JavaScript, expressions, CSS operations, or bindings.

## Apply any prototype behavior

Import helper from fixed viewer route. Callback receives complete selected state after connection and every change. Prototype owns all behavior: rebuild DOM, change classes/styles, start animations, or run other ordinary JavaScript.

```html
<script type="module">
  import { connectTweaks } from "/v/mockup/tweaks.js";

  connectTweaks(({ layout, motion, density }) => {
    const root = document.querySelector("#app");
    root.replaceChildren(renderProduct({ layout, density }));
    root.classList.toggle("motion", motion);
  });
</script>
```

`connectTweaks(callback)` returns a disconnect function. Values are a frozen snapshot; edit prototype state instead of mutating snapshot.

## Request full reload

Use reload when selected combination must restart document rather than update in place. Wrapper restores compatible selections after reload and suppresses repeated reload requests for same combination.

```js
import { connectTweaks, requestTweaksReload } from "/v/mockup/tweaks.js";

connectTweaks((state) => {
  if (state.renderer === "restart") requestTweaksReload();
  bootApplication(state);
});
```

Sandbox keeps an opaque origin and no `allow-same-origin`. Wrapper retains selections across requested and live reloads; duplicate reload requests for unchanged selections are ignored. Switching artifact clears them. **Reset** restores defaults; **Copy JSON** copies current combination to clipboard and never writes files.
