{{phase}} boundary {{evaluationId}} ({{evaluationType}}) for work item {{workItemId}}.

Judge the reviewed commit only against the exact persistent boundary. A stage review stays within its stage tasks, story contracts, checks, and focus. A whole-branch review uses the recorded execution-start base and reviewed head, treating the complete diff as one integrated feature rather than repeating task reviews. Final E2E follows every persisted matrix case exactly and submits each `caseResult` once.

On an initial review, inspect the complete boundary and report every material evidence-backed finding. On re-review, verify prior findings and the bounded repair only; newly noticed pre-existing Major/Minor issues become residual risk. Never invent requirements, infer blocked E2E success, or prescribe broader hardening when a smaller correction satisfies the contract.

Begin exactly with `MERGE: YES`, `MERGE: YES_WITH_RISK`, or `MERGE: NO`. Identify Critical/Major/Minor severity separately from blocking impact. Collect fresh minimal evidence without modifying the work or copying credentials, private transcripts, tokens, keys, `.env` files, or unrelated logs. Generated runtime evidence stays outside the repository and must be referenced by an individual sanitized file path.
