# Internal prompt-scenario benchmarks

This development-only, domain-neutral framework compares versioned prompt conditions through bounded `general-purpose` subjects. It registers no Pi tool, extension, runtime UI, or API. E2E semantic quality is reviewed by independent subagents rather than an automatic scorer.

## Safety and execution

Real model calls are opt-in and generated data must remain under the repository's Git-ignored `.benchmark/` tree:

```bash
npm run eval:prompt -- --tier local --execute
npm run eval:prompt -- --suite planner-agent-boundaries --tier low --condition current-skill \
  --repetitions 1 --concurrency 4 --execute
npm run eval:prompt -- --tier low --condition current-baseline,outside-in-candidate \
  --scenario web-upload-recovery --repetitions 3 --concurrency 1 --execute
npm run eval:prompt -- resume --run .benchmark/prompt-scenarios/<suite>/<run-id> --execute
npm run eval:prompt -- report --run .benchmark/prompt-scenarios/<suite>/<run-id>
```

The CLI prints an execution preview, rejects unknown options, caps repetitions and total calls, and caps concurrency at harness `maxConcurrency`. There is no concrete model flag: routes follow configured tier order and verify both exact model availability and supported effort. Resolution attempts and the explicit provider-extension selection are recorded.

Each subject runs in a temporary isolated cwd with `--no-approve`, no discovered extensions/context/skills/prompt templates/themes, no tools, and no session. Built-in providers need no extension. Only `local-llm` or `ollama-cloud` may load their specific trusted repository provider extension; any other non-built-in provider fails closed. The PiBox package/runtime is never loaded into a subject. This is input isolation, not an OS sandbox.

Timeouts signal the detached process group with SIGTERM, wait a bounded grace period, then use SIGKILL and a final settlement bound. Direct and descendant processes are covered on platforms with process-group signaling.

## Runs, resume, and evidence

Directories are mode 0700 and files mode 0600. Symlinked, repository-external, or non-ignored output paths are rejected. A run keeps exact prompts, requests, raw response/event/stderr streams, parse/scoring errors, route attempts, and partial completion in `manifest.json`. `resume` validates the immutable selection, retains valid completed `result.json` evidence, discards only partial run directories, and executes pending keys.

Parser/scorer exceptions are converted to per-run hard failures, so malformed model output cannot abort the remaining batch or strand the manifest as running.

Original `runs/<key>/result.json` automatic evidence is immutable. `report` creates `scoring-revisions/<revision-id>/` with scorer version, revised parse/automatic records, and a revision report. It never rewrites original results. In `curation.json`, a verdict determines effective pass. Without a verdict, matching assertion overrides affect only schema/hard-failure outcomes in effective scoring; automatic normalized scores and pass values remain untouched.

## Planner agent-boundary method

`planner-agent-boundaries` loads the current `skills/plan-delivery/SKILL.md` directly and tests it against five synthetic seam maps. The scenarios cover coherent feature lanes, independent fan-out, expand–migrate–contract ordering, one shared state machine, and cross-platform context limits. Subjects return a bounded task/stage JSON sketch. Automatic scoring checks exact work ownership, expected task grouping, concurrency, durable-output ordering, and topology integrity.

## E2E review method

The separate `e2e-outside-in` suite declares `current-baseline` as the baseline role and identity, so comparison direction does not depend on launch order. Subjects receive the same concise Markdown output guidance; no rigid matrix schema or automatic semantic dimensions are imposed.

E2E suite `3.0.0` retains three shaping scenarios. Automatic handling checks only that a subject returned a non-empty result. A separate reviewer scores each result, then a final high-tier reviewer compares the paired observations and reports variance and limitations. `FANOUT_METHOD.md` documents the archived five-scenario v2 comparison method.
