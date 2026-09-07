# PiBox styled outputs

Provides Pikit-style visual structure adapted to `rattle`:

- Width-aware `●`, `❯`, and `✽` transcript components
- Compact built-in tool headers with running/success/error symbols
- Single-line `Loaded skill …` and `Loaded rule …` rows without redundant collapsed previews
- Shared lifecycle symbols and `└─ Done`/`Error` branches around third-party renderers
- Child-lifecycle icons and one status row for subagent spawn/continue: Starting, Running, Stopping, Done, Failed, Stopped, or detached-history Launched. Status precedes the indented Prompt and Result blocks; background acknowledgment instructions and AgentId stay in expanded details.
- Semantic tree/field summaries for other PiBox harness tools instead of raw JSON
- Separate `Prompt:` previews for subagent spawn/continue assignments: at most five wrapped content lines and 500 Unicode code points when collapsed; the configured tool-expand shortcut (Ctrl+O by default) reveals the full prompt. Limits and terminal-control sanitization are display-only.
- Syntax-colored canonical before/after diffs for resource create, update, and delete operations, with revision/timestamp noise removed
- Truly collapsed third-party results with configured expand-key hints and full expanded output
- Native per-call mouse expansion in Pi 0.85 fullscreen mode across harness tools (including `subagent_read`), built-ins, and third-party renderers. Ctrl+O retains global expansion. Clicks follow native availability once a result/partial result exists; renderer-owned mouse controls take precedence, and unhandled selection/scroll input passes through.
- Theme-normalized collapsed summaries without third-party foreground/background leakage
- Tool rows aligned with transcript message-body indentation
- `└─` status branches, counts, and expansion hints
- Head/tail limiting for expanded output
- Compact tool padding without transcript-wide background blocks
- Tight tool stacks with no automatic blank row between consecutive calls
- One explicit turn boundary before user prompts instead of stacked shell padding
- Inline truecolor previews for `#RGB` and `#RRGGBB`

Color previews preserve the exact visible hexadecimal text. URLs, Markdown link destinations, existing ANSI escapes, and fenced code are protected. Preview styling is deferred until a streamed message is finalized.

Pi does not expose public replacement hooks for normal transcript components. PiBox therefore uses a small idempotent, reload-aware compatibility patch around Pi's exported message and tool component classes. Built-in tool execution is preserved by wrapping Pi's own tool factories with visual renderers. Mouse regions come from the host component, preserving compatibility with Pi 0.84 keyboard-only runtimes and mixed host/peer package versions.
