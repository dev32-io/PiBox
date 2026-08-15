# Workflow Execution Benchmark

- Score: **98/100**
- Scenarios: 15
- Passed: 13
- Failed: 2
- Model policy: `openai-codex/gpt-5.6-luna#medium`

| Scenario | Runner | Score | Result | Findings |
| --- | --- | ---: | --- | --- |
| mixed-topology | deterministic | 100 | pass | — |
| resource-collision | deterministic | 100 | pass | — |
| blocking-failure | deterministic | 100 | pass | — |
| resume-after-repair | deterministic | 100 | pass | — |
| review-repair-loop | deterministic | 100 | pass | — |
| accept-residual-risk | deterministic | 100 | pass | — |
| atomic-parallel-conflict | deterministic | 100 | pass | — |
| post-check-rollback | deterministic | 100 | pass | — |
| dirty-canonical-preserved | deterministic | 100 | pass | — |
| final-journey-dedup | deterministic | 100 | pass | — |
| interrupted-run-recovery | deterministic | 100 | pass | — |
| durable-change-request-resume | deterministic | 100 | pass | — |
| routine-managed-workflow | openai-codex/gpt-5.6-luna#medium | 90 | fail | task_complete failed: INVALID_HANDOFF: Reported commits do not match the task branch; task_complete failed: INVALID_HANDOFF: Reported commits do not match the task branch |
| targeted-task-clarify | openai-codex/gpt-5.6-luna#medium | 95 | pass | task_complete failed: INVALID_HANDOFF: Reported commits do not match the task branch |
| worker-change-request | openai-codex/gpt-5.6-luna#medium | 87 | fail | task_complete failed: INVALID_HANDOFF: Reported commits do not match the task branch; Observed 1 user escalation(s); expected 0. |
