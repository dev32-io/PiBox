# PiBox styled outputs

Provides Pikit-style visual structure adapted to `rattle`:

- Width-aware `●`, `❯`, and `✽` transcript components
- Compact built-in tool headers with running/success/error symbols
- Single-line `Loaded skill …` and `Loaded rule …` rows without redundant collapsed previews
- Shared lifecycle symbols and `└─ Done`/`Error` branches around third-party renderers
- Truly collapsed third-party results with configured expand-key hints and full expanded output
- Theme-normalized collapsed summaries without third-party foreground/background leakage
- Tool rows aligned with transcript message-body indentation
- `└─` status branches, counts, and expansion hints
- Head/tail limiting for expanded output
- Compact tool padding without transcript-wide background blocks
- Tight tool stacks with no automatic blank row between consecutive calls
- One explicit turn boundary before user prompts instead of stacked shell padding
- Inline truecolor previews for `#RGB` and `#RRGGBB`

Color previews preserve the exact visible hexadecimal text. URLs, Markdown link destinations, existing ANSI escapes, and fenced code are protected. Preview styling is deferred until a streamed message is finalized.

Pi 0.84.1 does not expose public replacement hooks for normal transcript components. PiBox therefore uses a small idempotent, reload-aware compatibility patch around Pi's exported message and tool component classes. Built-in tool execution is preserved by wrapping Pi's own tool factories with visual renderers.
