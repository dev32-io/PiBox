# PiBox status bar

A Pikit-spaced two-row footer adapted to `rattle`, with an upper model/project/Git/context row, full-width divider, and lower thinking/token/cache/cost row.

Formatting intentionally includes:

- `Thinking: MEDIUM` capitalization
- `T: total (cached cached) ↑ input ↓ output`
- Spaces after direction arrows
- One-decimal context percentage and `/ window` label
- Thin-block cyan/blue context gauge
- Leading and trailing row padding

Layouts switch explicitly at 110 and 72 columns while preserving the right-aligned context and usage groups.

Git status uses one asynchronous `git status --porcelain=v2 --branch` process every 10 seconds, with a three-second timeout, single-flight protection, failure backoff, cached rendering, and early refresh after file/Git-related activity. No subprocess runs from `render()`.
