# PiBox work modes

PiBox has four exclusive, session-scoped work modes. A new session defaults to **Agent**. Press `Down` from an empty editor to focus the mode icon in the first status-bar row, then press `Enter` or `Space` to open the selector. Inside the dialog, use arrow keys to select a mode, `Enter` to confirm, or `Esc` to cancel. `/mode` provides the same control from the command line.

| Mode | Icon | Purpose |
|---|---:|---|
| **Agent** | `` | Direct repository work with ordinary tools, product skills, subagents, and optional session scratch. |
| **Orchestrator** | `󰒪` | Plan- and ledger-driven coordination with deliberate bounded delegation and direct final verification. |
| **Workflow** | `󱄗` | Structured story and plan authoring plus managed staged implementation, review, repair, and E2E. |
| **Designer** | `󰏘` | Repository-aware visual design using `prompt/designer.md`, the closest `DESIGN.md`, and designer handoff resources. |

Modes select authority; they do not authorize an action by themselves. In particular, Workflow mode preserves the separate story-review, plan-review, explicit start/resume, permission-bypass, Git-isolation, Critical-risk, review, repair, and E2E gates described in the [workflow guide](workflow.md).

## Prompt-cache behavior

Agent and Workflow share PiBox's stable base instructions and product-skill catalog. Workflow tool schemas begin absent in a fresh Agent conversation. Before the first provider request that includes them, switching away may remove them again. After a provider request has exposed them, their definitions remain resident for the session branch, but calls are mechanically rejected outside Workflow mode.

Orchestrator and Designer intentionally change system instructions. Adding the Workflow schemas can also change a provider request. When conversation context already exists, the mode dialog warns that such a transition **may** cause a large prompt-cache miss and shows the current approximate context size. Switching does not erase the logical conversation.

Mode selection is stored as a private custom session entry. Restoration uses the active session-tree branch, so resume, reload, and tree navigation recover that branch's latest valid mode. `/new` and legacy sessions without an entry default to Agent. Forks inherit the selected mode.

The compatibility flag `pi --profile designer` remains accepted, but new usage should prefer `pi --work-mode designer` or the interactive selector. Pi's built-in `--mode` flag is reserved for choosing text, JSON, or RPC output and is intentionally not reused.

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

It is optional in Agent mode and initialized lazily when requested. Orchestrator mode initializes or restores it on the first model request because its working protocol requires a living plan and ledger. The workspace is non-authoritative: it never replaces repository source, reviewed contracts, authored workflow resources, workflow `state.yaml`, or workflow `ledger.yaml`.

Only the opaque binding is stored in the Pi session; scratch contents are not copied into session JSONL. A hidden bounded pointer is re-injected for active Agent/Orchestrator turns so it remains usable after compaction. Resume and reload revalidate the private layout before reuse. Forks get a distinct mutable workspace. If `/tmp` cleanup removes or invalidates saved scratch, PiBox reports the lost continuity rather than silently pretending it was restored.

Use `scratch_workspace` to inspect or initialize scratch and `/scratch status|reset|purge` for interactive lifecycle control. Reset and purge require confirmation. Scratch survives only as long as the operating system retains it; do not put secrets or uniquely durable evidence there.
