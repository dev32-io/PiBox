# PiBox styled outputs

Uses Pi's stable display-only Markdown transformer to add theme-aware `●`, `❯`, and `✽` transcript prefixes and inline truecolor previews for `#RGB`/`#RRGGBB` literals. Pi's built-in tool renderer receives the `rattle` tool backgrounds, title, output, and diff colors.

Color previews preserve the exact visible hexadecimal text. URLs, Markdown link destinations, existing ANSI escapes, and fenced code are protected. Preview styling is deferred until a streamed message is finalized.

Pi 0.84.1 does not expose a stable API for replacing the renderers of built-in tools or normal transcript message components. This initial implementation deliberately avoids prototype patching and result mutation; richer tool layouts can be added behind a documented compatibility layer after visual review.
