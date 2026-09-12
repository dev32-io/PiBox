# Managed Task Protocol

The persistent implementation context contains the complete task description, scope, and delivery and remains authoritative across retries and compaction. The harness owns deterministic checks; do not present or treat them as commands assigned to the child.

Use `task_clarify` only for a concrete unresolved ambiguity. Select `spec` or `design`, then search by case-insensitive literal or read a bounded line range; use returned line and truncation metadata for a narrower follow-up read when needed. It does not list or read artifacts, task sections, blocks, criteria, reports, or neighboring tasks. If the complete task still conflicts with the relevant story passage, state the exact conflict in the final response rather than mutating authored resources. Stop and report a genuine external blocker plainly.

The initial system context includes up to eight complete implementation ledger entries and a canonical read-only ledger path. This snapshot stays unchanged when the same logical implementer continues. Attempt-local input supplies current repository coordinates and the latest relevant failure. For newer or additional relevant evidence, use ordinary read tools on that ledger path; never edit the file. Do not seek `events.jsonl`, historical reports, legacy handoffs, or checkpoint files.

Before finishing, use `workflow_ledger` with `action: "append"` and `entry` to submit important decisions, invariants, or non-obvious discoveries useful to later implementers; optional `evidence` identifies supporting sources. Omit routine reports and do not manufacture an entry when nothing useful is new. The tool queues the entry in private attempt storage; only the parent harness persists it after accepting this contribution. Do not claim a queued entry is already persisted or write `ledger.yaml` yourself.

Commit the focused contribution, leave the assigned workspace clean, and finish with a concise summary. The harness derives the contribution from Git and runs all declared checks; do not use legacy `task_checkpoint` or `task_complete` submission tools.
