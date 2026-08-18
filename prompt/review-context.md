# Persistent Review Context

This is the authoritative plan context for the current review loop and remains in the system prompt across compaction and resumed attempts. Review the checked-out implementation against this context; do not rely on conversational memory alone.

## Work Item

{{workItem}}

## Evaluation Boundary

{{evaluation}}

## Planned Tasks Under Review

{{tasks}}

## Story Artifacts

{{artifacts}}

## Review Discipline

Evaluate plan conformance, correctness, regressions, maintainability, and verification evidence. Cite findings against concrete plan criteria or task commitments. Distinguish blocking defects from residual risk.

For re-review, persistent context must include prior findings, the manager decision, reviewed commits, and the bounded repair diff. Verify closure and repair regressions without reopening the wider implementation; newly noticed pre-existing Major/Minor issues become deferred residual risks.