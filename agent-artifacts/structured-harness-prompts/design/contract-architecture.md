# Contract Architecture

## Context

The harness has two complementary agent-facing surfaces: instructions that shape model behavior and artifacts that preserve decisions across sessions. Prompt quality cannot be improved independently of artifact quality because prompts need stable names and completion targets, while artifact validators need models to understand the intended semantic contract.

## Decisions

### Compact orchestrator contract

Inject one compact main-session contract that establishes routing, authority, phase boundaries, and progressive disclosure. Keep branch-specific procedures in skills so the always-loaded context remains small.

### Prompt contracts

Rewrite each prompt around observable inputs, instructions, completion criteria, and escalation conditions. Remove identity preambles and duplicated capability rules. Skill descriptions become trigger-only context pointers. Prompt Markdown is source code governed by static prompt-contract tests and behavioral scenarios; it is not a canonical narrative artifact and is not rendered through the artifact profile registry.

### Artifact section classes

Classify canonical narrative sections as required, optional, or conditional:

- Required sections must contain substantive visible content.
- Optional sections may be omitted.
- Conditional sections are required when an observable applicability condition is true.
- A non-applicable conditional section may be omitted; when the omission is materially informative, visible `Not applicable — <reason>` text is allowed.
- Empty headings, hidden comments, placeholders, and bare `N/A` do not satisfy a section.

### Structured rendering

Canonical narrative capabilities receive typed semantic section values. The registry validates those values and renders Markdown. Raw Markdown remains readable for schema-v1 compatibility but is not accepted by schema-v2 mutation inputs. Bounded `additionalSections` values permit domain-specific Markdown after reserved sections.

### Hybrid conditional validation

Capabilities infer applicability only from deterministic signals declared by each profile. Conditions requiring semantic judgment remain prompt and reviewer responsibilities. Validators report which declared trigger fired.

### Stable references

Use stable identifiers for binding acceptance criteria and findings. Extend deterministic cross-reference validation only where both the source identifier and reference field are structured; do not infer links from arbitrary prose.

### Compatibility

Read legacy artifacts without applying the new section contract. Validate new schema-v2 artifacts and explicitly migrated legacy artifacts. Do not rewrite historical content automatically.

## Components and Interfaces

- `artifact-contracts.ts`: artifact profiles, typed field validation, substantive-content checks, deterministic condition triggers, and diagnostics.
- `artifact-renderers.ts`: stable Markdown rendering from validated semantic values.
- `WorkItemStore`: invokes artifact validation and rendering before canonical mutation and renders structured report/outcome sections where the capability already owns structured data.
- Orchestrator capabilities: expose discriminated schema-v2 inputs and field-level errors.
- Skills: instruct the main session when to create each artifact and which semantic decisions belong there.
- Role and dynamic prompts: define bounded specialist procedures and structured terminal handoffs; static tests validate their prompt contracts.
- Prompt scenario fixtures: preserve baseline tasks, expected behavioral properties, and evaluation results for each rewritten surface.

The artifact contract registry is the single source of truth for canonical narrative shape. The prompt inventory and rubric are the separate source of truth for prompt-source contracts.

## Data and Control Flow

1. The orchestrator selects ad-hoc or managed work and loads the relevant workflow skill.
2. A schema-v2 canonical capability receives typed semantic values and an artifact profile.
3. The profile validates required fields, substantive content, stable identifiers, references, and declared conditional triggers.
4. The renderer emits reserved headings in stable order and appends validated additional sections.
5. Validation either returns precise diagnostics or permits the existing atomic mutation and planning-revision update.
6. Workers consume approved rendered artifacts through run-scoped context capabilities.
7. Evaluator and completion capabilities combine structured handoff data with deterministic Markdown rendering for stable reports and outcomes.

## Failure and Recovery

- Validation and rendering finish before any file, catalog, planning metadata, or Git mutation.
- Diagnostics identify artifact profile, field or section, semantic condition, and triggering signal.
- A mutation transaction includes its narrative file, structured metadata or catalog updates, planning revision, and one Git commit.
- Dirty canonical state fails before transaction work begins.
- Repository mutex acquisition wraps the complete transaction. Competing callers serialize; idempotency preserves replay semantics. No cross-process arrival order is promised.
- Existing atomic rollback behavior remains authoritative.
- A failed material update leaves the prior artifact, planning revision, and Git state unchanged.

## Security and Privacy

Prompt and artifact validation introduces no new trust boundary. Validators treat content as untrusted text, avoid executing embedded content, bound input, and never infer filesystem operations from Markdown. Conditional triggers flag security-relevant categories without logging secrets or copying sensitive values into diagnostics.

## Compatibility and Migration

Schema-v1 artifacts remain readable and completable under the approved work-item revision. A material update is an explicit canonical mutation that changes semantic section values, stable criteria, or binding references; lifecycle-only metadata updates are not material. Mixed work items are allowed during migration, but schema-v2 qualified criterion references may target only schema-v2 specifications. Referencing a legacy criterion requires explicit migration of that specification first.

## Verification Boundaries

- Unit tests cover typed validation, substantive content, section classes, conditional triggers, stable IDs, and rendering.
- Store integration tests prove validation occurs before mutation and failed writes preserve Git and planning state.
- Concurrency tests prove complete transaction serialization, idempotent replay, no partial commits, and no Git index-lock race without asserting scheduler arrival order.
- Prompt scenarios establish current baseline behavior before each rewrite and rerun unchanged after it.
- Cheap-model runs test routing, boundary discipline, artifact completeness, escalation, handoff validity, turns, and unnecessary work.
- A final managed E2E change exercises research, planning, approval, implementation, evaluation evidence, and outcome rendering; interruption and recovery use a separate focused scenario.

## Alternatives Considered

### Advisory linting

Rejected because malformed artifacts would still become canonical and downstream agents could not rely on their shape.

### Require every section

Rejected because it creates filler and universal ceremony unrelated to the work.

### Let hidden comments satisfy empty sections

Rejected because comments are invisible to human readers and create a trivial validation loophole.

### Fully infer conditional applicability

Rejected because semantic applicability cannot be determined reliably from syntax alone.

### Fully structured YAML instead of Markdown

Rejected because narrative rationale remains important for human review and model comprehension.
