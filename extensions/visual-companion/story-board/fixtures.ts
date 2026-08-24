import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { TASK_STATUSES } from "./projector.js";

export const ASSISTED_FIXTURE_MARKER = ".visual-companion-assisted-fixture.json";
export const ASSISTED_E2E_CASES = ["E2E-001", "E2E-002", "E2E-003", "E2E-004", "E2E-005", "E2E-006"] as const;
export const RECOVERY_STORY_ID = "malformed-recovery";

const documentTypes = [
	["intent", "intent", "intent.md"], ["product-spec", "spec", "specs/product.md"], ["secondary-spec", "spec", "specs/secondary.md"],
	["technical-design", "design", "design/technical.md"], ["decision-record", "decision", "decisions/choice.md"],
	["journey-matrix", "e2e-matrix", "e2e/journeys.md"], ["delivered-outcome", "outcome", "outcome.md"],
] as const;

async function put(root: string, relative: string, body: string | Uint8Array): Promise<void> {
	const path = join(root, relative); await mkdir(dirname(path), { recursive: true }); await writeFile(path, body);
}
function taskManifest(id: string, status: string): string {
	return stringify({ schemaVersion: 1, id, title: `${status.replaceAll("_", " ")} task`, status, dependsOn: [], execution: { assignment: { agent: "implementer", tier: "low", rationale: "Canonical assisted fixture" } }, assembly: { stageId: "fixture-stage" }, verification: { timing: "task", methods: ["browser inspection"], taskChecks: ["fixture"] } });
}
function evaluation(id: string, scope: Record<string, string>, type = "code-review", attempt = 2): string {
	return stringify({ schemaVersion: 1, id, type, ...(type === "e2e" ? { checkpoint: "final-e2e" } : type === "combined-review" ? { checkpoint: "final-review" } : {}), scope, status: "passed", required: true, attempt, result: { verdict: "pass", report: "report.md", riskAcceptance: "risk-acceptance.md", caseResults: [{ caseId: "E2E-001", status: "pass", executedActions: ["Inspect"], observations: ["Healthy"], evidenceRefs: ["EV-001"] }] }, findings: [{ id: "F-001", severity: "medium", status: "resolved", summary: "A resolved canonical finding", blocking: false }] });
}

/** Materialize the canonical matrix data under a new disposable repository. */
export async function createAssistedFixtureRepository(): Promise<AssistedFixtureRepository> {
	const repositoryRoot = await mkdtemp(join(tmpdir(), "visual-companion-e2e-"));
	await put(repositoryRoot, ASSISTED_FIXTURE_MARKER, JSON.stringify({ schemaVersion: 1, cases: ASSISTED_E2E_CASES }));
	const artifacts = join(repositoryRoot, "agent-artifacts");
	const active = join(artifacts, "active-delivery");
	const tasks = TASK_STATUSES.map((status, index) => ({ id: `task-${String(index + 1).padStart(2, "0")}-${status.replaceAll("_", "-")}`, path: `tasks/task-${String(index + 1).padStart(2, "0")}-${status.replaceAll("_", "-")}/task.yaml` }));
	for (const [index, status] of TASK_STATUSES.entries()) {
		const entry = tasks[index]!; await put(active, entry.path, taskManifest(entry.id, status));
		await put(active, `tasks/${entry.id}/brief.md`, `# ${status} brief\n\nFixture task detail.`); await put(active, `tasks/${entry.id}/acceptance.md`, "# Acceptance\n\nThe browser displays this task.");
	}
	const evaluations = [
		{ id: "task-report", path: "evaluations/task-report/evaluation.yaml", scope: { task: tasks[0]!.id }, type: "code-review" },
		{ id: "story-report", path: "evaluations/story-report/evaluation.yaml", scope: { workItem: "active-delivery" }, type: "code-review" },
		{ id: "stage-report", path: "evaluations/stage-report/evaluation.yaml", scope: { integrationUnit: "fixture-stage" }, type: "integration-review" },
		{ id: "final-report", path: "evaluations/final-report/evaluation.yaml", scope: { workItem: "active-delivery" }, type: "combined-review" },
		{ id: "e2e-report", path: "evaluations/e2e-report/evaluation.yaml", scope: { workItem: "active-delivery" }, type: "e2e" },
	];
	for (const report of evaluations) {
		await put(active, report.path, evaluation(report.id, report.scope, report.type));
		const reportRoot = `evaluations/${report.id}`; await put(active, `${reportRoot}/report.md`, `# ${report.id}\n\nCanonical report with [text evidence](../../evidence/${report.id}/note.txt) and a local image.\n\n![Local evidence](../../evidence/${report.id}/pixel.png)\n\n![External image](https://example.invalid/tracker.png)`);
		await put(active, `${reportRoot}/risk-acceptance.md`, "# Accepted risk\n\nA bounded fixture risk was accepted."); await put(active, `${reportRoot}/attempts/1-report.md`, "# Attempt 1\n\nChanges requested."); await put(active, `${reportRoot}/attempts/2-report.md`, "# Attempt 2\n\nPassed.");
		const evidenceRoot = `evidence/${report.id}`;
		await put(active, `${evidenceRoot}/manifest.yaml`, stringify({ schemaVersion: 1, evaluation: report.id, entries: [{ id: "EV-001", path: "note.txt", result: "passed" }, { id: "EV-002", path: "pixel.png", description: "Canonical local image" }, { id: "EV-003", path: "missing.txt" }, { id: "EV-004", path: "unsupported.bin" }, { id: "EV-005", result: "External URL intentionally has no local path" }] }));
		await put(active, `${evidenceRoot}/note.txt`, "Canonical textual evidence"); await put(active, `${evidenceRoot}/pixel.png`, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")); await put(active, `${evidenceRoot}/unsupported.bin`, "unsupported");
	}
	const docs = documentTypes.map(([id, type, path]) => ({ id, type, path, status: "approved", narrativeSchemaVersion: 2 }));
	for (const [id, , path] of documentTypes) await put(active, path, `# ${id.replaceAll("-", " ")}\n\nCanonical readable Markdown for the assisted fixture.`);
	await put(active, "index.yaml", stringify({ schemaVersion: 1, id: "active-delivery", kind: "story", title: "Active delivery", phase: "execution", state: "active", planning: { revision: 3 }, artifacts: docs, tasks, integrationUnits: [], evaluations: evaluations.map(({ id, path }) => ({ id, path })) }));

	const historicalStories: ReadonlyArray<readonly [string, string, string, string]> = [["completed-story", "Completed story", "complete", "complete"], ["archived-story", "Archived story", "complete", "archived"], ["legacy-story", "Legacy historical story", "historical", "legacy"]];
	for (const [id, title, phase, state] of historicalStories) {
		const root = join(artifacts, id); await put(root, "intent.md", `# ${title}\n\nHistorical canonical fixture.`); await put(root, "index.yaml", stringify({ schemaVersion: 1, id, kind: "story", title, phase, state, planning: { revision: 1 }, artifacts: [{ id: "intent", type: "intent", path: "intent.md", status: "approved", narrativeSchemaVersion: 2 }], tasks: [], integrationUnits: [], evaluations: [] }));
	}
	const degraded = join(artifacts, "degraded-siblings"); await put(degraded, "tasks/broken-task/task.yaml", "id: broken-task\nstatus: [unterminated"); await put(degraded, "evaluations/broken-report/evaluation.yaml", "schemaVersion: 1\nid: broken-report\nfindings: [unterminated"); await put(degraded, "index.yaml", stringify({ schemaVersion: 1, id: "degraded-siblings", kind: "story", title: "Degraded sibling resources", phase: "execution", state: "active", planning: { revision: 1 }, artifacts: [{ id: "missing-design", type: "design", path: "design/missing.md", status: "draft", narrativeSchemaVersion: 2 }], tasks: [{ id: "broken-task", path: "tasks/broken-task/task.yaml" }], integrationUnits: [], evaluations: [{ id: "broken-report", path: "evaluations/broken-report/evaluation.yaml" }] }));

	const recoveryRoot = join(artifacts, RECOVERY_STORY_ID); const validRecovery = stringify({ schemaVersion: 1, id: RECOVERY_STORY_ID, kind: "story", title: "Recovered historical story", phase: "execution", state: "active", planning: { revision: 2 }, artifacts: [], tasks: [], integrationUnits: [], evaluations: [] });
	await put(recoveryRoot, "index.valid.yaml", validRecovery); await put(recoveryRoot, "index.yaml", "id: malformed-recovery\ntitle: Malformed historical story\nstate: active\ninvalid: [unterminated");
	const architectureArtifactPath = join(repositoryRoot, "architecture.json"); await put(repositoryRoot, "architecture.json", JSON.stringify({ version: 1, title: "Assisted fixture architecture", views: [{ id: "production-composition", title: "Production composition", nodes: [{ id: "backend", label: "Visual Companion backend" }, { id: "story-board", label: "Story Board" }, { id: "architecture", label: "Architecture" }], edges: [{ id: "story", source: "backend", target: "story-board" }, { id: "arch", source: "backend", target: "architecture" }] }] }));
	let cleaned = false;
	return { repositoryRoot, architectureArtifactPath, recoveryStoryId: RECOVERY_STORY_ID, cases: [...ASSISTED_E2E_CASES], async recoverMalformedResource() { await put(recoveryRoot, "index.yaml", validRecovery); }, async cleanup() { if (!cleaned) { cleaned = true; await rm(repositoryRoot, { recursive: true, force: true }); } } };
}

export interface AssistedFixtureRepository {
	repositoryRoot: string; architectureArtifactPath: string; recoveryStoryId: string; cases: string[];
	recoverMalformedResource(): Promise<void>; cleanup(): Promise<void>;
}
