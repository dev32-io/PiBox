# Product → Shape → Plan Prompt Checks

Use these lightweight model scenarios after changing `product-discussion`, `shape-story`, `plan-delivery`, or their resource tools. Run in disposable repositories and keep transcripts outside the project.

## Required behavior

- discussion narrows the outcome before offering shaping;
- shaping is collaborative rather than immediate serialization;
- no story is written before validation of the complete proposed `spec`, `design`, and `e2e`;
- story prose is free-form and has no required taxonomy, criterion IDs, block IDs, or E2E case schema;
- first persistence stops for explicit user story review and never enters planning in the same turn;
- planning begins only after a later explicit request;
- tasks use only metadata, `description`, `scope`, `delivery`, deterministic `checks`, and assignment, with no story/artifact refs;
- independent compatible tasks share a concurrent stage; dependencies use later stages or a justified sequential baton pass;
- stage review authors only optional mode/focus, while retry count remains harness-only;
- the planner creates no evaluations, reports, handoffs, repair tasks, or outcome projections;
- `task_clarify` remains an exceptional bounded line-read/literal-search surface over story `spec` or `design`;
- planning submission does not start execution.

## Scenarios

### Greenfield product

Start with an empty repository and a broad request such as “Let's build a todo app.” Verify useful product narrowing, a proportionate Markdown-rich checkpoint with the required story/design/E2E sections, flat specialized writes, validation-only compilation, separate persistence/review, and one coherent implementation-plus-proof task.

### Existing domain ambiguity

Provide a small codebase whose vocabulary conflicts with the request. Verify the agent challenges the terms, cross-references code, explores concrete failure/recovery scenarios, and updates only the affected story field after review.

### End-to-end request

Ask for both story and implementation plan initially. Verify the request enters shaping but does not waive validation or the persisted-story review gate. Require a later prompt to begin planning.

### Resource shape

Use Markdown with headings chosen for the specific story rather than a stock template. Confirm exact round-trip through `story.yaml`. Author a minimal task and ordered stage; reject narrative refs, authored evaluation resources, and plan-local repair counts.

## Inspection

1. Identify the first canonical write and confirm a user-validated checkpoint precedes it.
2. Confirm the first plan-delivery load occurs in a later turn after story review.
3. Read `story.yaml`, `plan.yaml`, and every `tasks/*.yaml` completely.
4. Confirm no obsolete narrative/evaluation/report/handoff files were created.
5. Confirm execution did not begin without a clear later request and bypass confirmation.

Finish with focused prompt/resource tests, `npm run check`, and `git diff --check`; run the broader suite when the changed surface warrants it.
