# PiBox styled outputs

Provides Pikit-style visual structure adapted to `rattle`:

- Width-aware `●`, `❯`, and `✽` transcript components
- Compact built-in tool headers with running/success/error symbols
- `└─` status branches, counts, and expansion hints
- Head/tail limiting for expanded output
- Compact tool padding without transcript-wide background blocks
- Inline truecolor previews for `#RGB` and `#RRGGBB`

Color previews preserve the exact visible hexadecimal text. URLs, Markdown link destinations, existing ANSI escapes, and fenced code are protected. Preview styling is deferred until a streamed message is finalized.

Pi 0.84.1 does not expose public replacement hooks for normal transcript components. PiBox therefore uses a small idempotent, reload-aware compatibility patch around Pi's exported message and tool component classes. Built-in tool execution is preserved by wrapping Pi's own tool factories with visual renderers.
