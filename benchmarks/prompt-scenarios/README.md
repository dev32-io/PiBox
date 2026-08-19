# Internal prompt-scenario benchmarks

This development-only, domain-neutral framework compares versioned prompt conditions through bounded `general-purpose` subjects. It registers no Pi tool, extension, runtime UI, or API. The E2E schema and scorer remain suite-owned under `suites/e2e/`.

## Safety and execution

Real model calls are opt-in and generated data must remain under the repository's Git-ignored `.benchmark/` tree:

```bash
npm run eval:prompt -- --tier local --execute
npm run eval:prompt -- --tier low --condition current-baseline,outside-in-candidate \
  --scenario calendar-shaping-replay --repetitions 3 --concurrency 1 --execute
npm run eval:prompt -- resume --run .benchmark/prompt-scenarios/e2e-outside-in/<run-id> --execute
npm run eval:prompt -- report --run .benchmark/prompt-scenarios/e2e-outside-in/<run-id>
```

The CLI prints an execution preview, rejects unknown options, caps repetitions and total calls, and caps concurrency at harness `maxConcurrency`. There is no concrete model flag: routes follow configured tier order and verify both exact model availability and supported effort. Resolution attempts and the explicit provider-extension selection are recorded.

Each subject runs in a temporary isolated cwd with `--no-approve`, no discovered extensions/context/skills/prompt templates/themes, no tools, and no session. Built-in providers need no extension. Only `local-llm` or `ollama-cloud` may load their specific trusted repository provider extension; any other non-built-in provider fails closed. The PiBox package/runtime is never loaded into a subject. This is input isolation, not an OS sandbox.

Timeouts signal the detached process group with SIGTERM, wait a bounded grace period, then use SIGKILL and a final settlement bound. Direct and descendant processes are covered on platforms with process-group signaling.

## Runs, resume, and evidence

Directories are mode 0700 and files mode 0600. Symlinked, repository-external, or non-ignored output paths are rejected. A run keeps exact prompts, requests, raw response/event/stderr streams, parse/scoring errors, route attempts, and partial completion in `manifest.json`. `resume` validates the immutable selection, retains valid completed `result.json` evidence, discards only partial run directories, and executes pending keys.

Parser/scorer exceptions are converted to per-run hard failures, so malformed model output cannot abort the remaining batch or strand the manifest as running.

Original `runs/<key>/result.json` automatic evidence is immutable. `report` creates `scoring-revisions/<revision-id>/` with scorer version, revised parse/automatic records, and a revision report. It never rewrites original results. In `curation.json`, a verdict determines effective pass. Without a verdict, matching assertion overrides affect only schema/hard-failure outcomes in effective scoring; automatic normalized scores and pass values remain untouched.

## Conditions and envelope limitation

The suite declares `current-baseline` as the baseline role and identity, so comparison direction does not depend on CLI order. Both conditions share a neutral envelope derived from current matrix fields: summary, cases, questions, exclusions, and optional free-form `instructionArtifacts`. The envelope does not name obligations, traceability, amendment classifications, or candidate rubric concepts. Candidate instructions must elicit those structures themselves.

Requiring any common structured envelope can still influence formatting, and free-form `instructionArtifacts` makes adaptation less deterministic. This is an explicit trade-off: it avoids teaching the candidate method to baseline while retaining machine-scoreable shared case fields.

The E2E suite deeply validates unique IDs, nested records, scenario-approved source IDs, exact obligation-to-case/gap coverage when instruction-specific traceability is present, planning ID preservation, and intended-field concept evidence. Keywords placed only in questions, gaps, or exclusions do not earn behavior coverage.
