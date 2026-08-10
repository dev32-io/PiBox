import assert from "node:assert/strict";
import test from "node:test";
import { MIN_GIT_POLL_INTERVAL_MS, normalizeStatusBarConfig } from "../config.js";
import { parsePorcelainV2 } from "../git.js";
import { formatGit } from "../segments/format.js";

test("parses porcelain v2 branch and worktree counts", () => {
	const snapshot = parsePorcelainV2([
		"# branch.oid 0123456789abcdef",
		"# branch.head feature/status",
		"# branch.upstream origin/feature/status",
		"# branch.ab +2 -1",
		"1 M. N... 100644 100644 100644 a a staged.ts",
		"1 .M N... 100644 100644 100644 a a modified.ts",
		"2 RM N... 100644 100644 100644 a a R100 renamed file.ts\toriginal.ts",
		"? untracked file.ts",
	].join("\n"));
	assert.deepEqual(snapshot, {
		insideWorkTree: true,
		branch: "feature/status",
		staged: 2,
		modified: 2,
		untracked: 1,
		ahead: 2,
		behind: 1,
	});
	assert.equal(formatGit(snapshot), "feature/status +2 *2 ?1 ↑2 ↓1");
});

test("shows a short object id while detached", () => {
	const snapshot = parsePorcelainV2("# branch.oid 0123456789abcdef\n# branch.head (detached)\n");
	assert.equal(snapshot.detachedOid, "01234567");
	assert.equal(formatGit(snapshot), "@01234567");
});

test("clamps aggressive polling intervals", () => {
	assert.equal(normalizeStatusBarConfig({ git: { pollIntervalMs: 10 } as never }).git.pollIntervalMs, MIN_GIT_POLL_INTERVAL_MS);
});
