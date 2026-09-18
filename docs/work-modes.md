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

### Orchestrator: plan-driven development (PDD)

For substantial, separable work, Orchestrator defaults to early ad hoc delegation for research, implementation after approval, and independent review. Clear local reversible work, trivial operations, and tightly coupled steps can stay direct; substantial work kept entirely local needs a concrete reason. Pre-approval delegation is read-only research or critique. Findings that could affect the approach must be collected, reviewed, and reconciled before drafting or presenting a delivery plan.

The loop is **Research → Plan → Approval → Execution until the agreed goal is met**. Once enough findings support a useful approach, the parent proactively writes and shows a discussion draft in scratch `plan.md`—without waiting for a separate plan request. The draft records Goal, Deliverable, verifiable Done criteria, assumptions, dependencies, and a step-by-step checklist, and is revised as discussion and targeted research clarify what the user wants. A plan request is not approval; implementation and implementation delegation wait for approval, which never bypasses tool permissions. After approval, execution continues within the agreed scope without routine user prompts until Done criteria are met. Completed checks are marked promptly, blocked work stays unchecked, and the checklist is reconciled before reporting. Genuine blockers, required approvals, material plan changes, and user-reserved decisions still require a pause.

Plan to maximize safe concurrency: checkboxes track completion, not execution order. Group independent work into lanes, name real prerequisites and integration checks, and launch ready assignments within available capacity rather than waiting for unrelated lanes or whole batches. Ad hoc branches/worktrees may isolate parallel edits, but shared interfaces, build outputs, and test services still need coordination. Integrate and verify contributions in dependency order.

The parent owns `plan.md`, `ledger.md`, synthesis, integration, and final verification. Children receive self-contained assignments and explicit read-only or edit authority; parallel edits need disjoint ownership and compatible interfaces. Background results arrive automatically: do independent work or wait at a dependency barrier, never poll. Results arriving during compaction remain in the existing pending-delivery queue; compaction proceeds normally, and delivery resumes after the session is truly idle. An extension-owned internal command uses Pi's supported `waitForIdle()` boundary without creating a model-visible user message or granting approval. Read truncated reports rather than continuing a child just to retrieve them; inspect settled partial attempts before reassigning only the remaining gap. Review is not approval, and Orchestrator grants no Workflow authority.

`ledger.md` retains useful facts, decisions and rationale, evidence pointers, delegated findings, ruled-out approaches, and unresolved issues—not a chronological log. At goal changes and completion, consolidate notes and remove obsolete detail using judgment, retaining useful pointers without hard caps or mandatory archives. Scratch remains a flexible memo board and workbench; its files and directories are starting points, not limits. These are prompt instructions, not a validated schema, runtime enforcement of PDD, or evidence of live delegation behavior.

Only the opaque binding is stored in the Pi session; scratch contents are not automatically copied into session JSONL. A shared request-time system-prompt layer appends bounded workspace paths after mode instructions, including during background wakes and tool continuations. Paths remain stable while the workspace is unchanged; no plan or ledger contents are injected. The same layer supplies initialized E2E workspace paths after child agent instructions, without giving children main-session mode authority or creating evaluations implicitly. These contributions are excluded from compaction summarization requests. Pointers remind the model to consult relevant notes after compaction or resume while prioritizing current user direction and repository evidence. This is guidance, not an enforced read or a guarantee of fresh notes. PiBox does not summarize, trim, archive, or checkpoint scratch automatically, and does not depend on the model predicting compaction. Existing notes are left untouched on restore. Workspace resolution revalidates the private layout before reuse, including live `/tmp` deletion as well as resume and reload. Forks get a distinct mutable workspace. If `/tmp` cleanup removes or invalidates saved scratch, PiBox reports the lost continuity rather than silently pretending it was restored.

Use `scratch_workspace` to inspect or initialize scratch and `/scratch status|reset|purge` for interactive lifecycle control. Reset and purge require confirmation. Scratch survives only as long as the operating system retains it; do not put secrets or uniquely durable evidence there.

When the Visual Companion is running, its **Scratch** tab appears only if this session's active branch has a valid scratch workspace. Opening the companion does not create scratch. The tab provides read-only Markdown views of **Plan** and **Ledger**, updated automatically when either file changes, including editor saves that replace a file. Live updates preserve the selected note and scroll position, pause when hidden, and catch up on return or reconnection; **Refresh** remains available. Watchers start only for connected viewers and close on disconnect, binding changes, or companion shutdown. Tab availability refreshes while the browser page is visible and when returning to it; missing or purged scratch removes the tab. Reads are capped at 128 KiB per note with a visible truncation notice, without changing the files. Scripts, results, metadata, arbitrary file paths, and other sessions' scratch are not served. Raw HTML and images in notes are inert; evidence paths remain text, not local file access.
