# PiBox work modes

PiBox has four exclusive, session-scoped work modes. A new session defaults to **Orchestrator**. Press `Alt+Down` from an empty editor to focus the mode icon in the first status-bar row, then press `Enter` or `Space` to open the selector. Inside the dialog, use arrow keys to select a mode, `Enter` to confirm, or `Esc` to cancel. `/mode` provides the same control from the command line.

| Mode | Icon | Purpose |
|---|---:|---|
| **Agent** | `` | Direct repository work with ordinary tools, product skills, subagents, and optional session scratch. |
| **Orchestrator** | `󰏿` | Plan discussion and approval, flexible scratch, deliberate bounded delegation, and direct final verification. |
| **Workflow** | `󱄗` | Structured story and plan authoring plus managed staged implementation, review, repair, and E2E. |
| **Designer** | `󰏘` | Repository-aware visual design using `prompt/designer.md`, the closest `DESIGN.md`, and designer handoff resources. |

Modes select authority; they do not authorize an action by themselves. In particular, Workflow mode preserves the separate story-review, plan-review, explicit start/resume, permission-bypass, Git-isolation, Critical-risk, review, repair, and E2E gates described in the [workflow guide](workflow.md).

## Prompt-cache behavior

Agent and Workflow share PiBox's stable base instructions and product-skill catalog. Workflow tool schemas begin absent in a fresh Agent conversation. Before the first provider request that includes them, switching away may remove them again. After a provider request has exposed them, their definitions remain resident for the session branch, but calls are mechanically rejected outside Workflow mode.

Orchestrator and Designer intentionally change system instructions. Adding the Workflow schemas can also change a provider request. When conversation context already exists, the mode dialog warns that such a transition **may** cause a large prompt-cache miss and shows the current approximate context size. Switching does not erase the logical conversation.

Mode selection is stored as a private custom session entry. Restoration uses the active session-tree branch, so resume, reload, and tree navigation recover that branch's latest valid mode. `/new` and legacy sessions without an entry default to Orchestrator. Explicit saved modes, including Agent, remain unchanged on resume or reload. Forks inherit the selected mode. Use `/mode agent` or `--work-mode agent` for direct work without the Orchestrator plan-approval step.

The compatibility flags `pi --profile designer` and `pi --profile default` remain accepted; `default` now selects Orchestrator. New usage should prefer `pi --work-mode <mode>` or the interactive selector. Pi's built-in `--mode` flag is reserved for choosing text, JSON, or RPC output and is intentionally not reused.

## Session scratch

Session scratch is an opaque private workspace under `/tmp`:

```text
/tmp/pibox-session-<opaque-id>/
├── meta.json
├── plan.md
├── ledger.md
├── scripts/
└── results/
```

It is optional in Agent mode and initialized lazily when requested. Orchestrator mode makes it available on the first model request and actively encourages its use without enforcing a particular structure or maintenance lifecycle. The workspace is non-authoritative: it never replaces repository source, reviewed contracts, authored workflow resources, workflow `state.yaml`, or workflow `ledger.yaml`.

Orchestrator discusses the approach, presents a concise plan in its response, and waits for user approval before substantial execution. Scratch supports that work as a flexible memo board and workbench: plans, decisions, findings, evidence, scripts, experiments, intermediate output, and other useful working material. Within that workspace, `plan.md` is a practical step-by-step checklist for delivering the agreed goal: next actions, dependencies, completion checks, and which implementation work must run sequentially or can be delegated to independent parallel subagents. It guides execution and evolves with progress rather than existing as paperwork. `ledger.md` is a concise rolling record of execution context so later work can continue without repeating prior investigation. It preserves meaningful progress together with what was established, decisions and rationale, approaches tried or ruled out, evidence pointers, and unresolved issues—not merely a list of completed actions. The provided files and directories are starting points, not an exhaustive list of uses. The model can organize and extend the workspace, revisiting and cleaning up at logical boundaries using judgment while preserving information that may still help. This is not a prescribed lifecycle or a validated schema.

Only the opaque binding is stored in the Pi session; scratch contents are not automatically copied into session JSONL. A hidden bounded pointer is re-injected for active Agent/Orchestrator turns, with a reminder to consult relevant scratch notes after compaction or resume while prioritizing current user direction and repository evidence. This is guidance, not an enforced read or a guarantee of fresh notes. PiBox does not summarize, trim, archive, or checkpoint scratch automatically, and does not depend on the model predicting compaction. Existing notes are left untouched on restore. Resume and reload revalidate the private layout before reuse. Forks get a distinct mutable workspace. If `/tmp` cleanup removes or invalidates saved scratch, PiBox reports the lost continuity rather than silently pretending it was restored.

Use `scratch_workspace` to inspect or initialize scratch and `/scratch status|reset|purge` for interactive lifecycle control. Reset and purge require confirmation. Scratch survives only as long as the operating system retains it; do not put secrets or uniquely durable evidence there.

When the Visual Companion is running, its **Scratch** tab appears only if this session's active branch has a valid scratch workspace. Opening the companion does not create scratch. The tab provides read-only Markdown views of **Plan** and **Ledger**, refreshed on entry or with **Refresh**. Tab availability refreshes while the browser page is visible and when returning to it; missing or purged scratch removes the tab. Reads are capped at 128 KiB per note with a visible truncation notice, without changing the files. Scripts, results, metadata, arbitrary file paths, and other sessions' scratch are not served. Raw HTML and images in notes are inert; evidence paths remain text, not local file access.
