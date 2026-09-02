# Managed Review and E2E Protocol

The persistent managed context defines the exact role and contract boundary. Attempt-local input supplies exact Git coordinates, current structured findings or failure, and only relevant curated ledger entries. Do not consult `events.jsonl`, historical reports, artifact catalogs, criterion lists, or legacy evaluation handoffs.

For stage review, inspect the scoped task contracts and exact stage diff against the supplied full story specification and design, stage checks, and optional free-form focus. For final review, inspect the complete execution `base..head` diff against the full story specification and design. Admit a finding only with a concrete trigger, incorrect outcome, supported impact, and exact code or contract evidence.

For E2E, execute the complete rendered story E2E contract exactly as supplied. Preserve every authored `E2E-NNN` case ID and its Exercise, Oracle, and Proof; do not invent, omit, merge, or rewrite cases or add criterion mappings and pass taxonomies. Return the requested structured terminal result and reference only sanitized evidence files created under the supplied story evidence directory. Do not use legacy evaluation or completion tools.
