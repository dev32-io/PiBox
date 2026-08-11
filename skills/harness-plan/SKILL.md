---
name: harness-plan
description: Use when clarified work needs a durable deliverable contract before managed execution.
---

# Harness Planning

## Inputs

Start from the user's words and current repository evidence. Canonical capabilities are the only writers of `agent-artifacts/`.

## Clarify Before Writing

1. Separate stated requirements, observed repository facts, recommendations, and unresolved decisions. Find facts yourself; do not ask the user for information available from the repository or tools.
2. Map unresolved decisions as a dependency tree. The current frontier contains only decisions whose prerequisites are settled.
3. Ask the whole frontier in one concise numbered round. Explain the consequence of each choice and give a recommended answer. Do not ask downstream questions yet.
4. Wait for the user's answers, update the tree, and repeat. Do not turn silence, a generic request, or your preferred stack into user requirements.
5. When the frontier is empty, state the shared understanding and ask the user to confirm that canonical drafting should begin. A user may explicitly delegate specified choices.

Do not call `work_item_create`, artifact mutation, task, evaluation, or submission capabilities before that confirmation.

## Draft the Contract

1. Create or select the managed work item from the confirmed understanding.
2. Specify required behavior and stable acceptance criteria before technical design.
3. Record design and standalone decisions by reference, without duplicating rationale. Label delegated choices as such; omit unresolved material choices from claims of readiness.
4. Decompose tracer-bullet contributions with honest dependencies, resource claims, and intermediate state.
5. Group contributions at the smallest coherent integration boundary.
6. Map each binding criterion to credible proof at the cheapest meaningful boundary.
7. Declare only evaluations the plan requires.
8. Use a fresh plan critic when risk or ambiguity warrants independent judgment; resolve every blocking finding.

## Review With the User

Present the drafted contract in decision-oriented language: confirmed scope, important choices, recommendations adopted by delegation, verification boundaries, and any remaining questions. Invite corrections and wait. Revise through canonical capabilities until the user explicitly says the contract is ready for approval.

## Completion

Only then call `planning_submit`. State the frozen revision and approval command. The main session cannot approve its own plan.
