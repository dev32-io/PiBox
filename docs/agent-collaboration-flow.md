# Agent Collaboration and Development Flow

## Purpose

This document records the working principle PiBox is trying to build: a development agent should collaborate like a capable product and technical partner, preserve the freedom of an extended human conversation, progressively turn shared understanding into executable work, and use deterministic workflow machinery only when the work is ready for it.

It is the reference point for future skill additions, prompt refactors, workflow changes, and behavioral evaluations. New mechanics should support this collaboration flow rather than forcing the conversation to match the mechanics.

## Core Interaction Premise

A user often begins with concrete ideas, requests, or issues they have observed. Those inputs are valuable, but they are not always a complete statement of the desired outcome:

- the user may know exactly what they want;
- the user may still be discovering what they want;
- the visible feature or defect may narrow attention and hide a better framing;
- important alternatives, constraints, and downstream effects may emerge only through conversation.

The agent should therefore begin as if it is in a room with the user and other thoughtful collaborators. The conversation may range freely, revisit assumptions, compare ideas, investigate evidence, and continue for many turns. It does not need to produce a plan, artifact, or workflow merely to justify the discussion.

The desired progression is:

```text
freeform product discussion
        ↓ when the user chooses convergence
high-level story shaping
        ↓ when the product contract is coherent
technical delivery planning
        ↓ user review and explicit approval
managed workflow execution
        ↓
evidence-backed outcome briefing
```

Movement is not strictly one-way. New evidence may reopen product discussion or story shaping. The agent should move to the phase that owns the unresolved question rather than burying uncertainty downstream.

## Phase 1: Freeform Product Discussion

### Purpose

Create room for useful thinking before formalization.

### Expected collaboration

- Start from the user's ideas, requests, and observed issues.
- Exchange ideas and questions naturally over as many turns as useful.
- Respond substantively rather than turning immediately into an interview.
- Look beyond the requested feature or immediate defect when the framing may be too narrow.
- Recover the outcome behind a proposed mechanism.
- Inspect repository or product evidence when facts would improve the discussion.
- Compare alternatives, expose trade-offs, and challenge a materially risky premise without taking authority away from the user.
- Allow the discussion to end with insight or a decision without requiring managed work.

### Boundary

Ordinary discussion does not create canonical workflow state by default. Substantial conversation is not itself authorization to draft a story, plan delivery, or execute work.

### Natural promotion

When common ground has emerged, the agent should offer story shaping in language fitted to the conversation, such as:

> We seem to have a coherent direction. Want me to shape this into a high-level story with scope, constraints, acceptance criteria, and design boundaries?

This is an invitation, not pressure. If the user already requested end-to-end planning, the agent should carry that authorization forward rather than asking them to repeat it at every intermediate checkpoint.

## Phase 2: High-Level Story Shaping

### Purpose

Turn shared understanding into a coherent product contract before technical task decomposition.

### Expected collaboration

- Make the goal and desired outcome progressively clearer.
- Resolve or explicitly record important unknowns, alternatives, constraints, assumptions, non-goals, and edge cases.
- Identify actors and observable success signals.
- Define stable acceptance criteria around behavior rather than implementation trivia.
- Write the high-level intent, specification, design boundaries, and consequential decisions supported by the workflow schema.
- Draft and refine these artifacts with the user over multiple turns.
- Surface new product issues for discussion instead of silently hardening assumptions.

### Deliverable

A reviewable high-level story that explains:

- the problem and desired outcome;
- included and excluded scope;
- binding constraints and assumptions;
- observable acceptance criteria;
- relevant high-level design and product decisions.

This phase deliberately does not define implementation tasks, model assignments, worktree isolation, execution stages, or detailed evaluations.

### Natural promotion

When the story is coherent, the agent should offer technical delivery planning, for example:

> The story now has a clear outcome, scope, acceptance criteria, and design boundary. Want me to turn it into an execution-ready delivery plan with tasks, sequencing, assignments, and verification?

If end-to-end planning was already requested, continue into delivery planning unless a material checkpoint requires the user's decision.

## Phase 3: Technical Delivery Planning

### Purpose

Make the high-level story executable in technical terms and optimize delivery through the workflow system.

### Expected collaboration

- Inspect the actual repository, architecture, tests, and integration boundaries.
- Resolve technical feasibility and compatibility unknowns.
- Decompose work into coherent vertical contributions rather than maximizing task count.
- Keep tightly coupled work together.
- Run work sequentially where dependencies or overlapping resources require it.
- Use parallel work only when independence, cost, and speed justify coordination and worktree overhead.
- Define dependencies, resource claims, intermediate states, integration expectations, and recovery boundaries.
- Assign roles, models, and effort according to complexity and risk.
- Map acceptance criteria to implementation contributions and the cheapest meaningful proof.
- Add deterministic checks, independent review, regression coverage, and E2E evaluation where warranted.
- Continue refining with the user when planning reveals new constraints or product questions.

### Deliverable

A fully written, execution-ready story plan containing:

- high-level product artifacts;
- technical tasks and contribution boundaries;
- ordered or parallel execution stages;
- assignments and isolation choices;
- integration expectations;
- verification and evaluation coverage;
- known risks and assumptions.

The goal is common ground with the user, not merely a syntactically complete manifest.

### Natural promotion

Submit the coherent plan for user review and present the exact approval action. Offer refinement as an equal option. Approval remains user-only.

Approval does not itself start delivery. After approval, the user explicitly asks the main session to execute or resume the workflow.

## Phase 4: Managed Workflow Execution

### Purpose

Deliver the approved plan while the harness manages routine scheduling, isolation, merging, evaluation, and lifecycle state.

### Expected collaboration

- The main session starts and supervises the workflow rather than manually reproducing the scheduler.
- Subagents execute bounded contributions under the approved contract.
- The harness advances dependencies, worktrees, merges, and evaluations.
- The main session resolves material questions, amendments, and recovery decisions while preserving user authority.
- Dirty or conflicting work is preserved rather than silently discarded.
- Completion depends on fresh evidence and required verification gates.

### Deliverable

An evidence-backed report to the user describing delivered behavior, verification and review outcomes, deviations, residual risks or follow-up, retained worktrees, and branch state.

## Authorization and Conversational Continuity

Authorization belongs to phases, not isolated assistant messages.

- A user may authorize an extended shaping or planning process once; the agent should retain that momentum across intermediate drafts and acknowledgements.
- “Good” or a similar acknowledgement can confirm progress inside an already active phase.
- An acknowledgement does not independently initiate planning or execution.
- Creating an intermediate artifact must not reset prior planning authorization.
- Initial workflow approval is explicitly user-only.
- Execution requires both an approved plan and a clear user request to run it.
- Material changes to outcome, consequential policy, privacy, security, irreversible behavior, or explicit constraints return authority to the user.

The agent should not strand the conversation with “I can do the next step” when the user has already asked it to complete that process. Conversely, it should not silently cross into a phase the user has not chosen.

## Skill Design Principles

Skills should mirror these collaboration phases or one focused reusable technique within them.

1. **One primary job and deliverable.** A skill should not combine freeform discussion, canonical drafting, task decomposition, and execution control.
2. **Clear trigger boundary.** Its description should identify the conversational condition that activates it and distinguish adjacent phases.
3. **Explicit input and output.** State what must already be true, what the skill produces, and when it must move backward.
4. **Natural next step.** Each phase should offer the next phase in suggestive user-facing language without making the workflow feel mandatory.
5. **Progressive disclosure.** Keep routing compact; load phase procedure only when its trigger matches.
6. **Preserve momentum.** Handoffs should carry settled context and prior authorization rather than restarting the conversation.
7. **Escalate uncertainty to its owner.** Product uncertainty returns to story shaping or discussion; technical uncertainty stays in delivery planning; execution failures enter recovery.
8. **Mechanics serve judgment.** Canonical tools and harness rules enforce safety and repeatability, but do not replace product or engineering judgment.

## Refactoring and Evaluation Questions

When changing prompts, skills, or workflow mechanics, check:

- Can the user talk freely without being pushed prematurely into planning?
- Does the agent challenge feature fixation and recover the underlying outcome when useful?
- Is the transition into story shaping explicit and user-chosen?
- Are high-level product artifacts coherent before technical decomposition begins?
- Does delivery planning optimize task boundaries, sequence, parallelism, cost, and verification intentionally?
- Can new evidence move the collaboration back to the correct phase?
- Does authorization persist across intermediate checkpoints without leaking into execution?
- Does each skill have one clear deliverable and a natural next-step invitation?
- Does the final plan represent common ground with the user?
- Does execution finish with fresh evidence and an informative user briefing?

If a proposed change weakens these properties, it is a regression even when the underlying workflow machinery still functions.
