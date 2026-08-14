# Product → Shape → Plan Process Evaluation

Use this lightweight model-driven benchmark after changing `product-discussion`, `shape-story`, `plan-delivery`, or their resource tools. Run sessions in disposable repositories and store session/output files outside the repository so canonical writes see a clean branch.

## Pass criteria

Every scenario must satisfy:

- product discussion narrows the outcome before offering shaping;
- shaping is a collaborative technical round, not immediate serialization;
- domain terms, consequential alternatives, and concrete edge/failure scenarios are challenged where relevant;
- no story resource is written before the user validates a presented checkpoint;
- persisted intent, specification, and design agree and contain no placeholders;
- shape-story stops for explicit story review and never invokes plan-delivery in the same turn;
- acknowledgements such as “looks good” do not silently start planning;
- planning starts only after an explicit post-review request;
- tasks are self-contained runnable tracer bullets without artifact-reference instructions;
- `task_clarify` remains an exceptional route to additional story context, not required startup behavior;
- resource calls produce no schema, truncation-limit, or dirty-repository errors;
- the planner reads each child artifact/task it claims to review;
- generated evaluations use ticket-like authoring input successfully on the first call.

## Scenarios

### Greenfield product

Start with an empty repository and a broad request such as “Let’s build a todo app.” Verify product narrowing, a proportionate story checkpoint, separate persistence/review, and a first task that combines setup with visible behavior.

### Existing domain ambiguity

Provide a small codebase and `CONTEXT.md` whose vocabulary conflicts with a requested change, such as whole-order cancellation versus partial line cancellation. Verify glossary challenge, code cross-reference, scenario-driven model sharpening, explicit tradeoffs, and targeted story revision after review feedback.

### End-to-end request

Ask for both a story and implementation plan in the initial prompt. Verify the request enters shaping but does not waive checkpoint validation or the persisted-story review gate. Require a separate later prompt to start planning.

### Resource tolerance

During shaping, author a specification using the concise vocabulary (`kind: spec`, `content.behaviors`, `content.acceptance`) and aliases such as `specification`. During planning, author a ticket-like evaluation using `kind`, `context`, `criteria`, and `checks`. Both should succeed without schema discovery or retries.

## Inspection

Inspect both the JSONL transcript and `agent-artifacts`:

1. List user messages, assistant text, tool calls, and tool errors in order.
2. Identify the first canonical write and confirm a user-validated checkpoint precedes it.
3. Identify the first plan-delivery load and confirm it occurs in a later turn after story review.
4. Read intent, every spec/design/decision, every task brief/acceptance contract, and every evaluation manifest.
5. Record regressions and corrective changes before rerunning a clean final scenario.

Always finish with `npm run check`, `npm test`, and `git diff --check`.
