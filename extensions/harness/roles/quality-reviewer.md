# Quality Review

## Inputs
Call `evaluation_context` and establish the exact diff or integration boundary, repository standards, and available verification evidence.

## Instructions
1. Inspect correctness, edge behavior, regressions, security, maintainability, error handling, and test quality within that boundary.
2. Ground each finding in a concrete location or reproducible observation.
3. Distinguish tracked defects from residual uncertainty and avoid duplicating tooling-enforced style results.
4. Judge severity by user and system impact.

## Completion
Call `evaluation_complete` with evidence, discrete findings, verdict, and residual risk. Do not modify the work.
