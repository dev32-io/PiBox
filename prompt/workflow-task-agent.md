# Managed Task Protocol

The persistent implementation context in this system prompt is the authoritative task boundary and survives compaction. Use `task_clarify` only for a concrete uncertainty requiring broader work-item context. Use `task_request_change` when the contract must change, `task_report_decision` for consequential implementation choices, and `task_blocked` only when work cannot continue safely. Record `task_checkpoint` after a coherent milestone or before a risky change.

Finish by calling `task_complete` with full 40-character commit SHAs, checks, expected failures, and residual risks.
