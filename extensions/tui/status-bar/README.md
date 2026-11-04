# PiBox status bar

A Pikit-spaced footer adapted to `rattle`, with an upper model/project/Git/context row, full-width divider, and lower settings/stats row. Registered local services share one compact ordered state row below it.

Formatting intentionally includes:

- sentence-case state values such as `Permissions Enforced`, `Effort Medium`, `Tier Performance`, and `Fast Main+Sub≤Med`
- session model-tier profile after effort and before compact `Fast` request scope
- One-decimal context percentage and `/ window` label
- Leading and trailing row padding

## Powerline pills

When the theme exposes `getFgAnsi` (every real Pi theme), the footer is drawn with powerline glyphs; hosts without it (tests, minimal hosts) keep the plain `│`-divided text layout (`Permissions: Enforced │ Effort: Medium`, `T: total (cached ~NN%) ↑ in ↓ out │ $cost`, `›` selection marker with a reserved two columns).

- **Context gauge** (row 1, right): one pill whose body ` 11.5% / 1.0M ` doubles as the bar. The left edge is square; the body is at least `wideGaugeWidth`/`mediumGaugeWidth`/8 columns (never shorter than its text). Cells up to `round(percent × width)` are filled with `accent` and dark text (`warning` from `warningPercent`, `error` from `errorPercent`); the rest is a dark track with muted text. The rounded end U+E0B4 takes the last cell's background. Unknown usage renders ` — / 1.0M ` unfilled.
- **Settings** (row 2, left): separate rounded pills (U+E0B6 … U+E0B4), one space apart, `icon label value` — shield U+F132 Permissions, lightbulb U+F0EB Effort, sliders U+F1DE Tier, bolt U+F0E7 Fast. Normal: dark pill, dim icon and label, value in its semantic color. Alarm (Permissions Bypass): `warning` pill, dark bold text. Selected: `accent` pill, dark text, bold value. Selection does not change widths, so it never changes which pills fit.
- **Stats** (row 2, right): a back-chain joined by left-pointing arrows (U+E0B2) ending in a rounded cap: tokens (U+F0EC, total, cache rate), `↑in ↓out`, and — only when cost is shown — the cost on the lighter `borderMuted` slate.
- **Services** (own row): dark pills `icon label state` with `●` (success), `○` (dim), `◌` (warning), `!` (error), derived from the service adapter's status text; selected is an `accent` pill. Icons by service: Mem0 database U+F1C0, SearXNG search U+F002, Visual companion eye U+F06E, anything else server U+F233.

Pill and chain backgrounds come from theme tokens (`accent`, `warning`, `error`, `borderMuted`) via the same foreground→background derivation as the header chain. Dark pill bodies are fixed rattle slates because no theme token is dark enough: `#1E2C35` (services, tokens block) and `#26363F` (settings, ↑↓ block, gauge track).

Fit order: the header chain sheds blocks from the right, then settings shed Fast, then Tier; the stats chain is dropped when Permissions and Effort do not both fit beside it. Every line stays within the terminal width.

Layouts switch explicitly at 110 and 72 columns while preserving the right-aligned context and usage groups. The service row retains the same leading/trailing padding and width-safe truncation as the former visual-companion row; plain-layout segments use `│` separators. The first row starts with one continuous oh-my-zsh agnoster-style powerline chain: a rounded cap (U+E0B6), the work-mode mark on cyan (`accent`), the model and provider in light text on slate (`borderMuted`), then a blue (`border`) folder block followed by a green (`success`, clean) or amber (`warning`, dirty) branch block (U+E0A0), each ending in a hard arrow (U+E0B0) with dark text. A dim `○` means intentionally stopped, not failed.

Git status uses one asynchronous `git status --porcelain=v2 --branch` process every 10 seconds, with a three-second timeout, single-flight protection, failure backoff, cached rendering, and early refresh after file/Git-related activity. No subprocess runs from `render()`.

The footer mounts the reusable `interactive-footer` controller. Press `Alt+Down` from an empty editor to enter, use the arrow keys to move between visible rows and elements, and press Enter to open the item's shared overlay dialog. Up from the first interactive row returns to the editor. Escape is swallowed while navigating the footer grid so it cannot accidentally interrupt the agent loop; inside a popup, Escape safely closes that popup.
