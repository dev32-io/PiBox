# PiBox Visual TUI Specification

**Status:** Approved for planning; implementation not yet started  
**Scope:** Visual presentation only  
**Theme:** `rattle`  
**Target:** Pi coding agent 0.84.1 or newer

## 1. Purpose

PiBox will provide an original, cohesive visual layer for Pi. It may use projects such as Pikit and other community TUI packages as implementation and design references, but PiBox will not install, copy, or depend on those packages.

This phase is limited to terminal presentation:

- Color theme
- Chat input frame
- Status bar
- Styled transcript and tool output
- Working spinner/message
- Startup header
- Inline hexadecimal color previews

The following are explicitly outside this phase:

- Skills
- Prompt templates
- Plan or chat workflow modes
- Permission gates
- MCP integrations
- Subagents
- Web tools
- System-prompt customization
- Provider quota integrations
- General agent behavior changes

## 2. Design goals

1. Make bare Pi easier to scan without turning the terminal into a dashboard full of noise.
2. Preserve native Pi editing, keyboard, autocomplete, scrolling, and session behavior.
3. Keep displayed metrics honest across cloud, gateway, and local providers.
4. Use stable Pi extension APIs where available.
5. Keep visual components independent and individually loadable.
6. Render correctly at wide, medium, and narrow terminal widths.
7. Keep expensive work out of component `render()` methods.
8. Support ANSI-safe width calculation, truncation, and wrapping.
9. Use a cool steel/cyan palette, with warm colors reserved for semantic warnings.
10. Avoid names and visuals that overstate the EVE/Caldari inspiration; it is a palette and interface reference, not a role-playing concept.

## 3. Repository layout

PiBox will not use Pikit's top-level `agent/` wrapper. Package resources live at the project root.

```text
PiBox/
├── docs/
│   └── specs/
│       └── visual-tui.md
├── extensions/
│   └── tui/
│       ├── chat-input/
│       │   ├── index.ts
│       │   ├── config.ts
│       │   ├── README.md
│       │   └── tests/
│       ├── status-bar/
│       │   ├── index.ts
│       │   ├── config.ts
│       │   ├── git.ts
│       │   ├── metrics.ts
│       │   ├── layout.ts
│       │   ├── segments/
│       │   ├── README.md
│       │   └── tests/
│       ├── styled-outputs/
│       │   ├── index.ts
│       │   ├── config.ts
│       │   ├── color-preview.ts
│       │   ├── components/
│       │   ├── README.md
│       │   └── tests/
│       ├── spinners/
│       │   ├── index.ts
│       │   ├── config.ts
│       │   ├── verbs.ts
│       │   ├── README.md
│       │   └── tests/
│       └── startup/
│           ├── index.ts
│           ├── discovery.ts
│           ├── layout.ts
│           ├── README.md
│           └── tests/
├── themes/
│   └── rattle.json
├── package.json
├── tsconfig.json
├── README.md
└── LICENSE
```

Each visual component gets its own directory beneath `extensions/tui/`. The package manifest will explicitly list component entry points instead of relying on accidental recursive discovery.

## 4. Theme: `rattle`

### 4.1 Direction

`rattle` combines:

- A cool, mostly neutral terminal foundation
- Steel blue and ice cyan accents
- Teal for successful and active states
- Desaturated inactive surfaces and borders
- Restrained amber for warnings and attention
- Red only for errors and destructive changes
- Violet/blue escalation for high reasoning levels

The ordinary interface must not be orange-dominant. Warm color is semantic, not decorative.

### 4.2 Draft palette

| Role | Value | Use |
|---|---:|---|
| Deep background reference | `#0B1116` | Terminal/background reference; Pi normally uses the terminal background |
| Base panel | `#101920` | Tool and pending surfaces |
| User panel | `#111C23` | User-message background |
| Raised panel | `#17212C` | Custom messages and raised surfaces |
| Selected panel | `#172A33` | Selected rows and active controls |
| Primary accent | `#62B8D6` | Prompt, primary focus, active border |
| Steel blue | `#478BC7` | Links, secondary focus, borders |
| Cool teal | `#4FB7A7` | Success and active status |
| Main text | `#DCE7EC` | Primary readable text |
| Muted text | `#91A3AE` | Secondary labels |
| Dim text | `#536570` | Inactive labels and borders |
| Warning amber | `#D6A45F` | Warnings and Bash mode |
| Error red | `#DF6B73` | Errors and removed lines |
| High reasoning blue | `#6D8FE8` | High thinking level |
| Extra-high violet | `#9B8EE8` | Extra-high thinking level |
| Maximum reasoning magenta | `#C27DBB` | Maximum thinking level, used sparingly |

These values are initial implementation targets and may be tuned after viewing the theme in WezTerm against the user's Solarized Dark terminal background.

### 4.3 Semantic behavior

- Normal UI: cyan, blue, teal, steel gray.
- Warning states: amber.
- Error/destructive states: red.
- Context pressure: cool gradient under normal load; amber/red only after thresholds.
- Thinking levels: visually escalate from gray to cyan, blue, violet, and muted magenta.
- Tool backgrounds remain subtle so transcript text retains contrast.

### 4.4 Theme tokens

`themes/rattle.json` will define all Pi-required theme tokens, including:

- Core UI and borders
- User/custom/tool backgrounds
- Markdown colors
- Diff colors
- Syntax colors
- Thinking-level borders
- Bash mode
- HTML export colors

If custom semantic tokens such as `separator` are useful to PiBox extensions but unsupported by Pi's formal theme schema, extensions must gracefully fall back to a standard token such as `dim` or `borderMuted`.

## 5. Chat input component

### 5.1 Goals

The input should retain the strongest qualities of Pikit's framed input while being independently implemented.

### 5.2 Default appearance

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ ❯ Write a message…                                                       │
└──────────────────────────────────────────────────────────────────────────┘
```

Default properties:

- Full rectangular Unicode frame
- One cell of horizontal padding
- `❯` prompt marker on the first body line
- Prompt marker in `accent`
- Border in `borderMuted` when idle
- Active/adaptive border color may follow Pi's current thinking level
- Bash input uses `bashMode`/warning amber
- No decorative companion or mascot

### 5.3 Required behavior

- Extend Pi's `CustomEditor` rather than replacing base editing behavior.
- Preserve cursor movement, IME positioning, history, paste, multiline input, shortcuts, and agent controls.
- Preserve Pi's autocomplete component.
- Keep autocomplete rows outside the visual box unless testing shows a clearer stable layout.
- Preserve Pi's viewport indicators.
- Embed `↑ N more` and `↓ N more` indicators in the top or bottom frame.
- In fullscreen mode, show `↓ Scroll to bottom` centered in the input's top frame only while the transcript viewport is not following its end.
- Treat a primary-button click on that label as `scrollToBottom()`, consume the click before transcript selection, and hide the label immediately after following resumes.
- Omit the label when its centered placement would overlap a native editor viewport indicator.
- Fall back to horizontal rails or native layout when terminal width is too small for a box.
- Ensure every rendered line is at most the supplied terminal width.
- Rebuild themed content after theme invalidation.

### 5.4 Initial configuration

Configuration should support at least:

```json
{
  "boxed": true,
  "paddingX": 1,
  "prefix": "❯",
  "borderColor": "borderMuted",
  "prefixColor": "accent",
  "adaptiveThinkingBorder": true,
  "narrowMode": "rails"
}
```

Config location and installation behavior will be decided separately. Defaults must work without a config file.

## 6. Status bar component

### 6.1 Purpose

The status bar provides immediate session, model, repository, and context information without implying provider-account information that Pi cannot reliably obtain.

### 6.2 Wide layout

Conceptual layout:

```text
PiBox │ GPT-5.6 Sol (OpenAI) │ ~/Development/PiBox │ main +2 ?1     ▋▋▋▋▋▋░░░░ 38% / 400k
◆ Permissions: Enforced │ Effort: Medium                    ↑ 124k ↓ 8.2k │ cache 71% │ $0.042
```

The exact PiBox mark and separators will be selected during implementation. The status bar should not require Nerd Font glyphs to remain understandable.

### 6.3 Medium layout

```text
GPT-5.6 Sol · Medium │ PiBox · main +2 ?1                 ▋▋▋▋▋▋░░░░ 38%
↑124k ↓8.2k · cache 71% · $0.042
```

### 6.4 Narrow layout

```text
GPT-5.6 Sol · MED · ctx 38%
PiBox · main ± · ↑124k ↓8k · $0.04
```

### 6.5 Responsive rules

The implementation must use explicit layout modes rather than only truncating a wide line.

Initial target breakpoints:

- Wide: `>= 110` columns
- Medium: `>= 72` and `< 110` columns
- Narrow: `< 72` columns

Breakpoints should be constants and testable. Final values may be tuned after visual testing.

Within each mode, segments have priorities. Lower-priority values disappear before higher-priority values are truncated.

Suggested priority order:

1. Model
2. Context percentage
3. Permission mode
4. Thinking level
5. Project/directory basename
6. Git branch/dirty state
7. Input/output token totals
7. Cost
8. Cache metrics
9. Provider
10. Full path
11. Session duration
12. Session name

### 6.6 Context usage

Use Pi's `ctx.getContextUsage()` as the canonical source for current context occupancy.

This is provider-independent session context information, not provider-account quota. It is derived from the latest provider-reported assistant usage when available and estimates trailing messages added after that response.

Display examples:

```text
ctx 152k / 400k · 38%
```

or with a gauge:

```text
▋▋▋▋▋▋▋░░░░░░░░░░░ 38% / 400k
```

If model context metadata or usage is unavailable, render an honest fallback:

```text
ctx —
```

Do not invent a zero percentage.

### 6.7 Context gauge

Default gauge:

- Width: 18 cells in wide mode
- Width: 10 cells in medium mode
- Optional omission in narrow mode
- Filled and unfilled glyph: `▋` or another width-stable Unicode block selected after testing
- Unfilled color: dim hull gray

Normal gradient:

```text
#31505D → #55B5C7 → #6D8FE8
```

Default pressure thresholds:

- Normal: below 70%
- Warning: 70% through 89.9%
- Error: 90% and above

Amber and red should appear only at the warning/error end of the gauge or label, not dominate normal context usage.

### 6.8 Current context versus cumulative session totals

The status bar must clearly distinguish:

- **Current context:** estimated tokens that may occupy the next request's context. This may fall after compaction.
- **Session totals:** cumulative input, output, cache, and cost across all assistant requests in the current branch/session. These continue increasing after compaction.

Example:

```text
ctx 90k / 400k · 22%       session ↑1.1M ↓84k · cache 640k · $1.42
```

Do not combine all token categories into a misleading single `T:` value without a clear definition.

### 6.9 Provider quotas and weekly usage

Initial PiBox status-bar scope does **not** include weekly, rolling-window, credit, or provider-account usage.

There is no unified quota model across:

- Claude subscription
- Anthropic API
- Codex/OpenAI subscription
- OpenAI API
- Google
- OpenRouter
- Custom gateways
- Ollama and other local models

Pi's provider response hooks may expose rate-limit headers for some transports, but those values are provider-specific and do not consistently mean weekly usage. Provider quota adapters may be designed later as separate optional functionality, with explicit user approval.

The initial status bar must omit unavailable account quota rather than display a fake `0%`.

### 6.10 Cost

- Sum `usage.cost.total` from completed assistant messages.
- Hide cost if unavailable rather than treating unavailable data as zero.
- Subscription-backed requests may legitimately report no metered dollar cost; the display should not imply API billing.

### 6.11 Git status

Display:

- Branch name or detached short commit
- Staged file count
- Modified/unstaged file count
- Untracked file count
- Optional ahead/behind counts if available without additional expensive commands

Example:

```text
main +2 *3 ?1
```

The status bar must remain useful without Nerd Fonts. Nerd Font icons may be an optional presentation layer, not a requirement.

## 7. Git refresh strategy

### 7.1 Default: polling

Git status polling is the approved default.

Initial default configuration:

```json
{
  "git": {
    "enabled": true,
    "refreshMode": "poll",
    "pollIntervalMs": 10000,
    "commandTimeoutMs": 3000,
    "includeUntracked": true
  }
}
```

A 10-second interval is the initial balance between freshness and subprocess overhead. The interval must be configurable and validated with a conservative minimum.

Recommended minimum accepted interval:

```text
2000 ms
```

Values below the minimum should clamp to the minimum or be rejected.

### 7.2 Polling constraints

- Poll only while a Pi TUI session is active.
- Poll only when the current directory is inside a Git worktree.
- Use an asynchronous subprocess.
- Never run Git synchronously from `render()`.
- Cache the latest successful result.
- Permit only one in-flight Git operation at a time.
- Skip a poll tick if the previous command is still running.
- Apply a command timeout.
- Stop timers and abort/ignore in-flight work during `session_shutdown` and reload.
- Request a TUI render only when the status snapshot changes.
- Avoid logging routine Git failures into the transcript.
- Back off or disable polling for the session after repeated failures.

### 7.3 Git command

Prefer one command that provides branch and worktree status, such as:

```bash
git status --porcelain=v2 --branch --untracked-files=normal
```

Parsing must handle:

- Normal branches
- Detached HEAD
- Initial repositories with no commit
- Rename/copy records
- Paths containing spaces
- Ahead/behind metadata
- Repositories without an upstream

If performance testing shows untracked scanning is costly in very large repositories, configuration should allow:

```json
{
  "git": {
    "includeUntracked": false
  }
}
```

### 7.4 Event-assisted refresh

Polling remains the default, but known Pi activity should also mark the Git cache stale and request an early refresh:

- `write` result
- `edit` result
- Bash commands likely to change files or Git state
- User `!git ...` commands
- Pi footer branch-change callback

Early refreshes must be debounced and must respect the single-flight rule.

## 8. Styled outputs component

### 8.1 Scope

Provide consistent visual rendering for:

- Assistant messages
- User messages
- Thinking blocks
- Built-in tool calls and results
- Bash execution
- Diffs
- Markdown file output
- Custom tool output where stable APIs allow it

### 8.2 Visual language

Default conceptual prefixes:

```text
● assistant
❯ user
✽ thinking
✓ successful tool
✗ failed tool
└─ tool status/detail
```

Colors derive from `rattle` theme tokens. Prefixes and labels should aid scanning without coloring entire paragraphs unnecessarily.

### 8.3 Stable API preference

Use stable APIs where possible:

- `pi.registerTool()` renderers for tool call/result presentation
- `pi.registerMarkdownTransformer()` for display-only Markdown enhancements
- `pi.registerMessageRenderer()` for custom message types owned by PiBox
- Theme-aware TUI components

Broad prototype patching of Pi internals is discouraged because it is sensitive to Pi releases. If a required assistant/user layout cannot be achieved with public APIs, any compatibility patch must be:

- Isolated
- Version-aware
- Idempotent across `/reload`
- Easy to disable
- Documented with its failure mode
- Covered by tests where practical

### 8.4 Tool output

- Tool headers should show action and concise target/summary.
- Success and error states should remain visible when output is collapsed.
- Expanded output must be line-limited.
- Large output must not flood the terminal.
- Edit/write diffs should use `toolDiffAdded`, `toolDiffRemoved`, and `toolDiffContext`.
- Paths should be shortened relative to the current project where possible.
- ANSI-safe wrapping and truncation are required.

## 9. Inline hexadecimal color previews

### 9.1 Goal

When normal rendered Markdown contains a hexadecimal color literal, visually render the literal using that color while preserving the exact text.

Example source:

```text
Primary is #62B8D6 and warning is #D6A45F.
```

Expected TUI behavior:

- `#62B8D6` gets background `#62B8D6`.
- `#D6A45F` gets background `#D6A45F`.
- Foreground becomes black or white according to calculated luminance/contrast.
- The visible text remains exactly the original hexadecimal token.
- The session message and model context remain unchanged.

This produces an inline color-chip effect without adding swatch characters that would pollute copied text.

### 9.2 Initial supported syntax

- `#RGB`
- `#RRGGBB`
- Uppercase or lowercase digits
- Normal prose
- Inline code spans, if transformation can preserve Markdown semantics safely

Potential later support:

- `#RGBA`
- `#RRGGBBAA`
- `rgb()` / `rgba()`
- `hsl()` / `hsla()`
- Named CSS colors
- Syntax-aware fenced code blocks

Alpha formats are deferred because terminal colors do not have an alpha channel and require a defined compositing background.

### 9.3 Implementation direction

Use `pi.registerMarkdownTransformer()` for normal user, assistant, and thinking Markdown. The transformation is display-only and runs again on terminal-width changes.

The transformer must:

- Be synchronous and inexpensive.
- Preserve original Markdown meaning.
- Avoid transforming link destinations and URL fragments.
- Avoid malformed heading interpretation around short hex values.
- Avoid injecting styles into existing ANSI sequences.
- Avoid fenced code blocks in the first version.
- Skip partial/streaming content if transformation causes flicker or incomplete-token artifacts.
- Wrap only the exact hexadecimal token in truecolor ANSI foreground/background sequences.
- Restore ANSI state after every token.
- Use ANSI-aware width utilities so styling remains zero-width.

Contrast foreground should be selected using a documented luminance formula. The initial implementation may use WCAG relative luminance or a simpler YIQ threshold if tests demonstrate adequate terminal readability.

### 9.4 Configuration

```json
{
  "colorPreviews": {
    "enabled": true,
    "messageTypes": ["user", "assistant"],
    "includeThinking": false,
    "includeInlineCode": true,
    "includeFencedCode": false,
    "formats": ["rgb3", "rgb6"]
  }
}
```

## 10. Spinners component

### 10.1 Behavior

Replace Pi's ordinary working message with a themed, low-noise animated status.

Features:

- Curated changing activity verbs
- Optional typewriter transition
- Elapsed time
- Approximate streamed token count where useful
- Theme-aware verb, separator, and status colors
- Hidden-thinking shortcut hint
- Correct cleanup during turn end, agent end, reload, and shutdown

Suggested initial verbs:

```text
Analyzing
Tracing
Mapping
Resolving
Synthesizing
Verifying
Refining
Reviewing
```

Avoid excessively whimsical or role-playing language.

### 10.2 Token estimate

A live token count based on streamed characters is necessarily approximate and must be labeled or visually treated as an estimate. Final provider-reported token usage belongs in the status bar/session metrics.

### 10.3 Animation constraints

- Do not update faster than necessary.
- Default verb cycle: approximately 2.5–4 seconds.
- Default elapsed-time update: 1 second.
- Do not leave timers alive after session shutdown or `/reload`.
- Avoid flicker in fullscreen and regular TUI modes.

## 11. Startup component

### 11.1 Purpose

Replace Pi's bare startup header with a visually coherent, responsive welcome panel.

### 11.2 Information

The first visual phase may show:

- PiBox mark/name
- Pi version
- Available/scoped model count
- Loaded PiBox TUI component count
- Context-file count
- Native command hint
- Native Bash hint
- Model-cycle shortcut
- Permission-mode shortcut (`Shift+Tab`); thinking-level selection remains available through Pi's native `/thinking` command

Do not show or advertise features that PiBox has not implemented, such as skills, MCP, plan mode, or chat mode.

### 11.3 Layout

Wide terminals may use a bordered multi-column layout. Medium and narrow terminals should use compact variants rather than disappearing entirely.

Possible wide structure:

```text
┌─ PiBox · Pi 0.84.1 ─────────────────────────────────────────────────────┐
│  mark/logo       8 models             / commands                        │
│                  5 TUI components      ! bash                            │
│                  2 context files       Ctrl+P model · Shift+Tab thinking │
└─────────────────────────────────────────────────────────────────────────┘
```

The final mark must remain neutral and readable without Nerd Fonts.

## 12. Configuration principles

- Every component must have sensible built-in defaults.
- Missing config must not be an error.
- Invalid config should fall back safely and optionally surface one concise notification.
- Config reading should not happen in hot render paths.
- Config should be reloadable without restarting Pi where practical.
- Theme values should prefer semantic theme tokens but allow validated six-digit hex overrides.
- Component configs should not depend on unrelated PiBox features.

The final runtime config location and setup mechanism require separate approval. This specification does not authorize modifying `~/.pi/agent/settings.json` or installing PiBox globally.

## 13. Performance requirements

1. Footer/editor render methods perform no synchronous filesystem or subprocess work.
2. Git polling uses one asynchronous, cached, single-flight process at a configurable interval.
3. Markdown transformations are synchronous, bounded, and linear in message length.
4. Styled-output components cache render results by width where appropriate.
5. Timers are created only after `session_start` and cleaned up at `session_shutdown`.
6. No timer runs solely because an extension module was imported.
7. Theme invalidation clears or rebuilds strings containing baked ANSI colors.
8. Every component must respect the terminal width supplied to `render()`.

## 14. Compatibility and accessibility

- Primary target is WezTerm with truecolor support.
- Basic presentation must work without Nerd Fonts.
- Do not rely on color alone for success, warning, or error meaning; retain symbols or labels.
- Respect Pi's native keybindings.
- Preserve IME cursor positioning through `CustomEditor` behavior.
- Provide plain Unicode/ASCII fallbacks where glyph width is uncertain.
- Test regular and fullscreen Pi TUI modes.
- Avoid backgrounds with insufficient contrast against `rattle` text colors.

## 15. Testing plan

### Theme

- Validate against Pi's theme schema.
- Exercise user, custom, pending, success, and error surfaces.
- Exercise Markdown, syntax, and diff colors.
- Verify all thinking levels.

### Chat input

- Single and multiline input
- Wrapped input
- Viewport indicators
- Autocomplete
- Paste
- Bash mode
- Narrow widths
- Theme reload

### Status bar

- Wide/medium/narrow snapshots
- No model
- Missing context metadata
- Local model with incomplete usage
- Subscription model without dollar cost
- Named/unnamed session
- Git clean/dirty/detached/no repository
- Long path and branch
- Context threshold boundaries
- Compaction causing current context to fall while totals remain cumulative

### Git polling

- Poll interval validation
- Single-flight behavior
- Command timeout
- Shutdown cleanup
- Snapshot-change render suppression
- Git failure/backoff
- Immediate event-assisted refresh

### Styled outputs

- All built-in tools
- Success/error/aborted states
- Expanded/collapsed output
- Large output limits
- Diffs
- Markdown files
- ANSI width correctness

### Color previews

- `#RGB` and `#RRGGBB`
- Upper/lowercase
- Light/dark contrast foreground
- Multiple colors on one line
- URLs and link fragments
- Markdown headings
- Inline code
- Fenced code skipped
- Streaming incomplete tokens
- Copyable original visible text

### Spinners/startup

- Timer cleanup
- Reload behavior
- Width variants
- Theme invalidation
- Regular/fullscreen modes

## 16. Implementation phases

Implementation requires a separate approval after this specification.

1. Project metadata and test foundation
2. `themes/rattle.json`
3. `extensions/tui/chat-input/`
4. `extensions/tui/status-bar/`
5. `extensions/tui/spinners/`
6. `extensions/tui/startup/`
7. `extensions/tui/styled-outputs/`
8. Inline hexadecimal previews
9. Integrated visual and performance testing
10. Local temporary preview using explicit Pi CLI paths
11. Separate review before any global installation or active Pi configuration changes

## 17. Approval boundaries

This specification records the intended design. It does not authorize:

- Installing community packages
- Copying community extension code
- Installing PiBox globally
- Editing the active `~/.pi` configuration
- Editing WezTerm configuration
- Adding nonvisual workflow features
- Calling private provider quota APIs

All implementation should be original and use community projects only as references. Global activation and configuration remain separate approval steps.
