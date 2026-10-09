# Managed Task Protocol

The persistent implementation context holds the complete task description, scope, and delivery and stays authoritative across retries and compaction. The harness owns and runs deterministic checks.

Use `task_clarify` only for a concrete unresolved ambiguity: select `spec` or `design`, then search by case-insensitive literal or read a bounded line range, using returned line and truncation metadata for a narrower follow-up. It does not list or read artifacts, task sections, blocks, criteria, reports, or neighboring tasks. If the complete task still conflicts with the relevant story passage, state the exact conflict in the final response rather than mutating authored resources. Stop and report a genuine external blocker plainly.

The initial system context includes up to eight complete implementation ledger entries and a canonical read-only ledger path; attempt-local input supplies current repository coordinates and the latest relevant failure. This snapshot stays unchanged when the same logical implementer continues. Read newer entries from the ledger path with ordinary read tools; never edit it. `events.jsonl`, historical reports, legacy handoffs, and checkpoint files are not context sources.

Before finishing, call `workflow_ledger` with `action: "append"` and `entry` for important decisions, invariants, or non-obvious discoveries useful to later implementers (optional `evidence` names sources). Omit routine reports; do not manufacture an entry when nothing useful is new. The tool queues the entry in private attempt storage and only the parent harness persists it after accepting this contribution, so a queued entry is not yet persisted; do not write `ledger.yaml`.

Commit the focused contribution, leave the assigned workspace clean, and finish with a concise summary. The harness derives the contribution from Git; do not use legacy `task_checkpoint` or `task_complete` tools.
