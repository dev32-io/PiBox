# Contract Architecture

## Context

The harness has two complementary agent-facing surfaces: instructions that shape model behavior and artifacts that preserve decisions across sessions. Prompt quality cannot be improved independently of artifact quality because prompts need stable names and completion targets, while artifact validators need models to understand the intended semantic contract.

## Decisions

### Compact orchestrator contract

Inject one compact main-session contract that establishes routing, authority, phase boundaries, and progressive disclosure. Keep branch-specific procedures in skills so the always-loaded context remains small.

### Prompt contracts

Rewrite each prompt around observable inputs, instructions, completion criteria, and escalation conditions. Remove identity preambles and duplicated capability rules. Skill descriptions become trigger-only context pointers.

### Artifact section classes

Classify sections as required, optional, or conditional:

- Required sections must contain substantive visible content.
- Optional sections may be omitted.
- Conditional sections are required when an observable applicability condition is true.
- A non-applicable conditional section may be omitted; when the omission is materially informative, visible `Not applicable — <reason>` text is allowed.
- Empty headings, hidden comments, placeholders, and bare `N/A` do not satisfy a section.

### Hybrid conditional validation

Capabilities infer applicability only from deterministic signals already available in structured state or artifact text, such as declared authentication, credentials, personal data, permission, external-network, migration, compatibility, or destructive-operation concerns. Conditions requiring semantic judgment remain prompt and reviewer responsibilities. Validators report what triggered a conditional requirement.

### Stable references

Use stable identifiers for binding acceptance criteria and findings. Extend deterministic cross-reference validation only where both the source identifier and reference field are structured; do not infer links from arbitrary prose.

### Compatibility

Read legacy artifacts without applying the new section contract. Validate new artifacts and materially updated legacy artifacts. Do not rewrite historical content automatically.

## Components and Interfaces

- `artifact-contracts.ts`: artifact profiles, section classes, heading parser, substantive-content checks, deterministic condition triggers, and diagnostics.
- `WorkItemStore`: invokes artifact validation before canonical mutation and renders structured report/outcome sections where the capability already owns structured data.
- Orchestrator capabilities: expose concise artifact contracts in tool descriptions and validation errors.
- Skills: instruct the main session when to create each artifact and which semantic decisions belong there.
- Role prompts: define bounded specialist procedures and structured terminal handoffs.
- Prompt scenario fixtures: preserve baseline tasks, expected behavioral properties, and evaluation results for each rewritten surface.

The contract registry is the single source of truth. Tool descriptions and documentation should derive from it or point to it rather than restating section rules independently.

## Data and Control Flow

1. The orchestrator selects ad-hoc or managed work and loads the relevant workflow skill.
2. A canonical artifact capability receives Markdown content and an artifact type.
3. The validator parses visible headings outside code fences and comments.
4. The artifact profile checks required order, substantive content, stable identifiers, and deterministic conditional triggers.
5. Validation either returns precise diagnostics or permits the existing atomic mutation and planning-revision update.
6. Workers consume approved artifacts through run-scoped context capabilities.
7. Evaluator and completion capabilities combine structured handoff data with deterministic Markdown rendering for stable reports and outcomes.

## Failure and Recovery

- Validation fails before any file or planning metadata changes.
- Diagnostics identify artifact type, section, semantic condition, and triggering signal.
- Existing dirty-branch and atomic rollback behavior remains authoritative.
- Legacy artifacts remain readable after upgrades.
- A failed material update leaves the prior artifact and planning revision unchanged.

## Security and Privacy

Prompt and artifact validation introduces no new trust boundary. Validators treat artifact content as untrusted text, avoid executing embedded content, bound parser input, and never infer filesystem operations from Markdown. Conditional triggers should flag security-relevant sections without logging secrets or copying sensitive values into diagnostics.

## Verification Boundaries

- Unit tests cover heading parsing, code fences, comments, duplicate/order errors, substantive-content rules, section classes, conditional triggers, stable IDs, and legacy behavior.
- Store integration tests prove validation occurs before mutation and failed writes preserve Git and planning state.
- Prompt scenarios establish current baseline behavior before each rewrite and rerun unchanged after it.
- Cheap-model runs test routing, boundary discipline, artifact completeness, escalation, handoff validity, turn count, and unnecessary work.
- A final managed E2E change exercises research, planning, approval, implementation, evaluation, outcome rendering, and recovery with the refined prompts and contracts.

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
