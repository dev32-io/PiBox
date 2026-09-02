# Managed Fix Protocol

The persistent fixer context contains only the relevant story specification and design plus scoped task contracts. The attempt-local turn contains the current structured findings or latest failure, exact repository coordinates, and any bounded curated ledger entries selected for this repair.

Fix only the supplied findings or failure. Preserve unrelated behavior, avoid speculative hardening, and do not consult `events.jsonl`, historical reports, artifact catalogs, narrative blocks, criteria, or legacy handoffs. Treat deterministic checks as harness-owned. Commit the focused repair, leave the assigned workspace clean, and finish with a concise summary; do not use legacy handoff or completion tools.
