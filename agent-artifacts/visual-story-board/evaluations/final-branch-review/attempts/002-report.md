# Evaluation Report: final-branch-review

## Boundary

{"workItem":"visual-story-board"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

## Re-review recommendation
Do not merge reviewed commit f507688dcbacdc71f90f3602854bc9a92aff1993. F-002 is resolved, and the original outside-repository story-root exploit is denied, but F-001 remains open because the bounded repair still permits a symlinked evaluation directory to rebase report-child containment onto another story inside the repository.

## Prior finding verification

### F-001 — Major, blocking — Still open
Fresh proof confirms a symlinked story root outside the repository now returns HTTP 404, and the added healthy-sibling route test passes. However, the repair does not validate `evaluationRoot` itself beneath the selected story before using it as the root for report, risk, and attempt reads.

Concrete trigger: story A's indexed evaluation directory is a symlink to story B's evaluation directory inside the same repository. `unsafeExistingTarget()` accepts the manifest because its realpath remains under `repositoryRoot`; the manifest read relative to story A degrades, but `regularFile(reportPath, evaluationRoot, repositoryRoot)` then treats the symlink target as the root. Fresh execution returned HTTP 200 and story B's report body from story A's report route.

Expected: symlinked/misbound evaluation children are denied and remain under the selected canonical story/evaluation identity. Actual: report content crosses story boundaries. Smallest correction: require `evaluationRoot` to be a non-symlink directory contained beneath the selected contained story root before reading any evaluation child, then add a cross-story evaluation-directory symlink route test.

### F-002 — Minor, non-blocking — Resolved
The reader now projects only `executionMode`, `completedCommit`, and `mergedCommit`; the API repeats the allowlist for injected readers, and the UI renders only those fields. Fresh proof confirms no absolute worktree or private run ID reaches projected task detail.

## Verification
- `npm run check`: passed.
- Repair-focused reader, route, UI, and evidence tests: 14/14 passed.
- Original outside-repository story-root reproduction: now HTTP 404.
- Bounded repair `git diff --check`: passed.
- Cross-story evaluation-directory reproduction: failed containment, HTTP 200 with the other story's report body.

## Evidence

- **EV-001:** Fresh original symlink reproduction after repair. — PASS: direct workspace now returns 404.
- **EV-002:** Fresh delivery-history projection proof. — PASS: no absolute worktree or run identifier.
- **EV-003:** Fresh cross-story evaluation-directory symlink reproduction. — FAIL: story A report route returned HTTP 200 with story B report body.
- **EV-004:** TypeScript verification. — PASS
- **EV-005:** Repair-focused test output. — PASS (14/14)
- **EV-006:** Bounded repair diff hygiene. — PASS

## Findings

- **F-001** (high, open): A symlinked evaluation directory can cause one story's report route to return another story's report body.
- **F-002** (medium, resolved): Raw runtime worktree paths and run IDs are no longer projected or rendered.

## Verdict

fail

## Residual Risk

- The prior full-suite run did not complete within 1200 seconds. This re-review appropriately ran only repair-focused checks; complete full-suite proof remains unavailable.
