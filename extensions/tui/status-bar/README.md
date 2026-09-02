# PiBox status bar

A Pikit-spaced footer adapted to `rattle`, with an upper model/project/Git/context row, full-width divider, and lower thinking/token/cache/cost row. Registered local services share one compact ordered state row below Thinking.

Formatting intentionally includes:

- sentence-case state values such as `Permissions: Enforced`, `Effort: Medium`, `Tier: Performance`, and `Fast: Main+Sub≤Med`
- session model-tier profile after effort and before compact `Fast:` request scope
- `T: total (cached cached) ↑ input ↓ output`
- Spaces after direction arrows
- One-decimal context percentage and `/ window` label
- Thin-block cyan/blue context gauge
- Leading and trailing row padding

Layouts switch explicitly at 110 and 72 columns while preserving the right-aligned context and usage groups. The service row retains the same leading/trailing padding and width-safe truncation as the former visual-companion row; segments use `│` separators. A dim `○` means intentionally stopped, not failed.

Git status uses one asynchronous `git status --porcelain=v2 --branch` process every 10 seconds, with a three-second timeout, single-flight protection, failure backoff, cached rendering, and early refresh after file/Git-related activity. No subprocess runs from `render()`.

The footer mounts the reusable `interactive-footer` controller. Press `Alt+Down` to enter, use the arrow keys to move between visible rows and elements, and press Enter to open the item's shared overlay dialog. Up from the first interactive row returns to the editor. Escape is swallowed while navigating the footer grid so it cannot accidentally interrupt the agent loop; inside a popup, Escape safely closes that popup.
