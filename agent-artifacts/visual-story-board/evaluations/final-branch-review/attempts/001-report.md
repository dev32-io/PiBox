# Evaluation Report: final-branch-review

## Boundary

{"workItem":"visual-story-board"}

## Criteria Evaluated

No qualified criteria declared.

## Observations

MERGE: NO

## Merge recommendation
Do not merge reviewed commit 16f3a8321f707c92a74f7ef8a32b36978afe57c3. The integrated feature has one blocking Major containment defect and one non-blocking Minor projection/privacy contract gap.

## Findings

### F-001 — Major, blocking — Symlinked story roots bypass repository containment
Category: defect.

A direct workspace/detail request for a valid story ID does not require the story to have passed the contained catalog enumeration. `storyRoot()` constructs a lexical path, while `regularFile()` compares a child realpath against the realpath of that story root. If the story root itself is a symlink outside the repository, both resolve outside and the check succeeds. Fresh proof showed the catalog omitted the symlink but `/v/story-board/api/workspace?story=escape-story` returned HTTP 200 with the outside story and task.

Expected: all canonical reads and routes reject symlinked/outside story roots. Actual: direct routes project outside-root files. This violates the read containment and symlink-rejection contracts and can also undermine report/evidence membership validation.

Smallest correction: validate each story directory itself as a non-symlink real directory contained beneath the real canonical `agent-artifacts` root, or authorize detail requests through an equivalent contained catalog lookup; add direct-route symlink tests.

### F-002 — Minor, non-blocking — Task projection exposes raw runtime paths and identifiers
Category: contract gap.

`readTaskDetail()` copies the complete task `runtime` mapping into `deliveryHistory`, and the browser renders it verbatim. Fresh proof against this work item confirmed an absolute worktree path and `lastRunId` are exposed. This conflicts with the browser-safe, sanitized repository-relative projection constraint and can leak local path/user details into screenshots.

Smallest correction: explicitly project approved delivery fields, repository-relativize or omit `worktree`, and omit internal run identifiers unless intentionally user-facing.

## Requirement conclusions
- Shell-first lifecycle, lazy Story Board activation, cache behavior, three-column projection, Markdown/evidence policy, shared shell/tokens, Architecture regression paths, and assisted-launcher focused checks: verified by passing typecheck and 50 focused tests.
- Canonical read/path containment: failed by F-001.
- Browser-safe sanitized projection: partially failed by F-002.
- Exact diff hygiene: passed.

## Verification
- `npm run check`: passed.
- Focused Visual Companion/Story Board/Architecture/service tests: 50/50 passed.
- `git diff --check` on the exact base..head boundary: passed.
- `npm test`: no failures were recorded through 275 tests, but the command did not complete within 1200 seconds.

## Evidence

- **EV-001:** Sanitized symlink-containment reproduction. — Catalog omitted symlink, but direct workspace returned 200 and outside story/task data.
- **EV-002:** Sanitized task projection proof. — Delivery history includes an absolute worktree and run identifier.
- **EV-003:** npm run check — PASS
- **EV-004:** npx tsx --test focused Visual Companion, Story Board, Architecture, and service-adapter tests — PASS (50/50)
- **EV-005:** Exact boundary diff hygiene. — PASS
- **EV-006:** Sanitized full-suite output captured until timeout. — No recorded failure through 275 tests; no terminal summary before 1200-second timeout.

## Findings

- **F-001** (high, open): Direct Story Board detail routes read through a symlinked story root outside the repository.
- **F-002** (medium, open): Task detail projects and renders raw runtime data containing absolute worktree paths and internal run IDs.

## Verdict

fail

## Residual Risk

- The full `npm test` run did not reach a terminal summary within the 1200-second evaluation window; its captured output contains no failure through 275 tests, so complete full-suite proof remains unavailable.
