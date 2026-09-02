import { randomUUID } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { atomicWriteFile, readTextIfExists } from "./repository.js";
import type { RuntimeOwner } from "../subagent/api.js";

export const WORKFLOW_METRIC_CATEGORIES = ["implementation", "integration", "verification", "review", "e2e"] as const;
export type WorkflowMetricCategory = (typeof WORKFLOW_METRIC_CATEGORIES)[number];

export interface StoryWorkflowMetrics {
	workflowMs: number;
	categories: Record<WorkflowMetricCategory, number>;
	open?: { category: WorkflowMetricCategory; since: string };
	incompleteIntervals: number;
	incompleteCategories: WorkflowMetricCategory[];
}

export type ActivationOwner = RuntimeOwner;
export type { RuntimeOwner };

export interface ActiveSlotAttempt {
	token: string;
	owner: RuntimeOwner;
	activatedAt: string;
}

export interface FailureSummary {
	code: string;
	summary: string;
}

export type DurableCheckStatus = "pending" | "running" | "passed" | "failed";
export interface DurableCheckState {
	id: string;
	status: DurableCheckStatus;
	failure?: FailureSummary;
}

export interface TaskRuntimeState {
	id: string;
	status: "pending" | "implementing" | "check_pending" | "checking" | "repair_pending" | "repairing" | "interrupted" | "completed" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "implementing" | "checking" | "repairing";
	repairCount: number;
	checks: DurableCheckState[];
	contributionCommit?: string;
	result?: FailureSummary;
	failure?: FailureSummary;
}

export interface IntegrationRuntimeState {
	status: "pending" | "integrating" | "repair_pending" | "repairing" | "interrupted" | "completed" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "integrating" | "repairing";
	repairCount: number;
	contributionCommits: string[];
	integratedCommit?: string;
	result?: FailureSummary;
	failure?: FailureSummary;
}

export interface VerificationRuntimeState {
	status: "pending" | "checking" | "repair_pending" | "repairing" | "interrupted" | "completed" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "checking" | "repairing";
	repairCount: number;
	checks: DurableCheckState[];
	result?: FailureSummary;
	failure?: FailureSummary;
}

export type FindingSeverity = "critical" | "major" | "minor";
export interface StructuredFinding {
	id: string;
	severity: FindingSeverity;
	code: string;
	summary: string;
	path?: string;
	line?: number;
}

export interface AcceptedRisk {
	findingId: string;
	rationale: string;
	acceptedAt: string;
}

export interface ReviewRuntimeState {
	status: "pending" | "reviewing" | "fix_pending" | "fixing" | "interrupted" | "completed" | "skipped" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "reviewing" | "fixing";
	iteration: number;
	repairCount: number;
	currentFindings: StructuredFinding[];
	acceptedRisks?: AcceptedRisk[];
	result?: FailureSummary;
	failure?: FailureSummary;
}

export interface E2ERuntimeState {
	status: "pending" | "testing" | "fix_pending" | "fixing" | "interrupted" | "completed" | "attention";
	attempt?: ActiveSlotAttempt;
	interruptedFrom?: "testing" | "fixing";
	repairCount: number;
	evidenceRefs: string[];
	result?: FailureSummary;
	failure?: FailureSummary;
}

export interface StageRuntimeState {
	id: string;
	status: "pending" | "running" | "completed" | "attention";
	tasks: TaskRuntimeState[];
	integration: IntegrationRuntimeState;
	verification: VerificationRuntimeState;
	review: ReviewRuntimeState;
}

/** Target domain state is local to the story store until scheduler integration. */
export interface StoryContractDigests {
	story: string;
	plan: string;
	tasks: Record<string, string>;
}

export interface StoryRuntimeState {
	schemaVersion: 1;
	storyId: string;
	status: "ready" | "running" | "paused" | "attention" | "completed" | "failed" | "stopped";
	activationOwner?: RuntimeOwner;
	attention?: FailureSummary;
	contracts: StoryContractDigests;
	git: {
		canonicalBranch: string;
		baseCommit: string;
		integrationBranch?: string;
		integrationWorktree?: string;
	};
	stages: StageRuntimeState[];
	finalReview: ReviewRuntimeState;
	e2e: E2ERuntimeState;
	metrics: StoryWorkflowMetrics;
	outcomeStatus?: "pending" | "written" | "failed";
}

export function hasWorkflowAttention(state: StoryRuntimeState): boolean {
	return state.status === "attention" || Boolean(state.attention)
		|| state.stages.some((stage) => stage.tasks.some((task) => task.status === "attention")
			|| stage.integration.status === "attention" || stage.verification.status === "attention" || stage.review.status === "attention")
		|| state.finalReview.status === "attention" || state.e2e.status === "attention";
}

export interface LedgerEntry {
	id: string;
	updatedAt: string;
	sourceRole: string;
	summary: string;
	evidence?: string[];
}

export interface StoryLedger {
	schemaVersion: 1;
	entries: LedgerEntry[];
}

export interface DebugRoute {
	provider: string;
	model: string;
	effort?: string;
}

export interface DebugUsage {
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/** Deliberately has no generic data field: debug events cannot carry content bodies or state patches. */
export interface StoryDebugEvent {
	type: string;
	stageId?: string;
	taskId?: string;
	slotId?: string;
	attemptToken?: string;
	durationMs?: number;
	route?: DebugRoute;
	usage?: DebugUsage;
	resultCode?: string;
}

export interface StoredStoryDebugEvent extends StoryDebugEvent {
	at: string;
	storyId: string;
}

export interface DebugTailFilter {
	types?: readonly string[];
	stageId?: string;
	taskId?: string;
	resultCodes?: readonly string[];
}

export interface StoryRuntimeStoreOptions {
	maxLedgerEntries?: number;
	maxDebugTailEntries?: number;
	maxDebugReadBytes?: number;
	now?: () => Date;
}

export interface StoryStateWriteResult {
	state: StoryRuntimeState;
	stateWritten: boolean;
	debugEventAppended: boolean;
}

const STORY_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFAULT_MAX_LEDGER_ENTRIES = 32;
const ABSOLUTE_MAX_LEDGER_ENTRIES = 100;
const DEFAULT_MAX_DEBUG_TAIL_ENTRIES = 50;
const ABSOLUTE_MAX_DEBUG_TAIL_ENTRIES = 200;
const DEFAULT_MAX_DEBUG_READ_BYTES = 256 * 1024;

export function emptyWorkflowMetrics(): StoryWorkflowMetrics {
	return {
		workflowMs: 0,
		categories: { implementation: 0, integration: 0, verification: 0, review: 0, e2e: 0 },
		incompleteIntervals: 0,
		incompleteCategories: [],
	};
}

function timestamp(value: string): number {
	const result = Date.parse(value);
	if (!Number.isFinite(result)) throw new Error(`Invalid workflow clock timestamp: ${value}`);
	return result;
}

/** Close the current exclusive interval at a durable transition and optionally open the next category. */
export function transitionWorkflowClock(metrics: StoryWorkflowMetrics, category: WorkflowMetricCategory | undefined, at: string): StoryWorkflowMetrics {
	const next = structuredClone(metrics);
	const atMs = timestamp(at);
	if (next.open) {
		const elapsed = atMs - timestamp(next.open.since);
		if (elapsed < 0) throw new Error("Workflow clock cannot move backwards");
		next.workflowMs += elapsed;
		next.categories[next.open.category] += elapsed;
	}
	if (category) next.open = { category, since: at };
	else delete next.open;
	return next;
}

/** Owner-loss recovery does not guess at the uncheckpointed interval. */
export function markWorkflowClockIncomplete(metrics: StoryWorkflowMetrics): StoryWorkflowMetrics {
	const next = structuredClone(metrics);
	if (next.open) {
		if (!next.incompleteCategories.includes(next.open.category)) next.incompleteCategories.push(next.open.category);
		delete next.open;
		next.incompleteIntervals += 1;
	}
	return next;
}

export function createAttemptToken(): string {
	return randomUUID();
}

export function isCurrentAttempt(slot: { status: string; attempt?: ActiveSlotAttempt }, token: string, owner: RuntimeOwner): boolean {
	return slot.attempt?.token === token
		&& slot.attempt.owner.activationId === owner.activationId
		&& slot.attempt.owner.processInstanceId === owner.processInstanceId
		&& slot.attempt.owner.sessionId === owner.sessionId;
}

function record(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const permitted = new Set(allowed);
	return Object.keys(value).every((key) => permitted.has(key));
}
function boundedString(value: unknown, maximum = 2_000): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}
function oneOf(value: unknown, allowed: readonly string[]): boolean {
	return typeof value === "string" && allowed.includes(value);
}
function nonNegativeInteger(value: unknown): boolean {
	return Number.isSafeInteger(value) && (value as number) >= 0;
}
function boundedArray(value: unknown, maximum: number): value is unknown[] {
	return Array.isArray(value) && value.length <= maximum;
}
function validSummary(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["code", "summary"]) && boundedString(value.code, 80) && boundedString(value.summary);
}
function validOptionalSummary(value: unknown): boolean {
	return value === undefined || validSummary(value);
}
function validOwner(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["sessionId", "processInstanceId", "activationId"]) && boundedString(value.sessionId, 200) && boundedString(value.processInstanceId, 200) && boundedString(value.activationId, 200);
}
function validAttempt(value: unknown): boolean {
	return value === undefined || (record(value) && onlyKeys(value, ["token", "owner", "activatedAt"]) && boundedString(value.token, 200) && boundedString(value.activatedAt, 80)
		&& Number.isFinite(Date.parse(value.activatedAt as string)) && validOwner(value.owner));
}
function validCheck(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["id", "status", "failure"]) && boundedString(value.id, 200) && oneOf(value.status, ["pending", "running", "passed", "failed"])
		&& validOptionalSummary(value.failure);
}
function validChecks(value: unknown): boolean {
	return boundedArray(value, 200) && value.every(validCheck);
}
function validFinding(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["id", "severity", "code", "summary", "path", "line"]) && boundedString(value.id, 200) && oneOf(value.severity, ["critical", "major", "minor"])
		&& boundedString(value.code, 80) && boundedString(value.summary) && (value.path === undefined || boundedString(value.path, 500))
		&& (value.line === undefined || (Number.isSafeInteger(value.line) && (value.line as number) >= 1));
}
function validReview(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["status", "iteration", "repairCount", "attempt", "interruptedFrom", "currentFindings", "acceptedRisks", "result", "failure"])
		&& oneOf(value.status, ["pending", "reviewing", "fix_pending", "fixing", "interrupted", "completed", "skipped", "attention"])
		&& nonNegativeInteger(value.iteration) && nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["reviewing", "fixing"]))
		&& boundedArray(value.currentFindings, 200) && value.currentFindings.every(validFinding)
		&& (value.acceptedRisks === undefined || (boundedArray(value.acceptedRisks, 200) && value.acceptedRisks.every((risk) => record(risk) && onlyKeys(risk, ["findingId", "rationale", "acceptedAt"])
			&& boundedString(risk.findingId, 200) && boundedString(risk.rationale) && boundedString(risk.acceptedAt, 80) && Number.isFinite(Date.parse(risk.acceptedAt as string)))))
		&& validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validTask(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["id", "status", "repairCount", "attempt", "interruptedFrom", "checks", "contributionCommit", "result", "failure"]) && typeof value.id === "string" && STORY_ID.test(value.id)
		&& oneOf(value.status, ["pending", "implementing", "check_pending", "checking", "repair_pending", "repairing", "interrupted", "completed", "attention"])
		&& nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["implementing", "checking", "repairing"]))
		&& validChecks(value.checks) && (value.contributionCommit === undefined || boundedString(value.contributionCommit, 200))
		&& validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validIntegration(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["status", "repairCount", "attempt", "interruptedFrom", "contributionCommits", "integratedCommit", "result", "failure"])
		&& oneOf(value.status, ["pending", "integrating", "repair_pending", "repairing", "interrupted", "completed", "attention"])
		&& nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["integrating", "repairing"]))
		&& boundedArray(value.contributionCommits, 200) && value.contributionCommits.every((commit) => boundedString(commit, 200))
		&& (value.integratedCommit === undefined || boundedString(value.integratedCommit, 200))
		&& validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validVerification(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["status", "repairCount", "attempt", "interruptedFrom", "checks", "result", "failure"])
		&& oneOf(value.status, ["pending", "checking", "repair_pending", "repairing", "interrupted", "completed", "attention"])
		&& nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["checking", "repairing"]))
		&& validChecks(value.checks) && validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validE2E(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["status", "repairCount", "attempt", "interruptedFrom", "evidenceRefs", "result", "failure"])
		&& oneOf(value.status, ["pending", "testing", "fix_pending", "fixing", "interrupted", "completed", "attention"])
		&& nonNegativeInteger(value.repairCount) && validAttempt(value.attempt)
		&& (value.interruptedFrom === undefined || oneOf(value.interruptedFrom, ["testing", "fixing"]))
		&& boundedArray(value.evidenceRefs, 64) && value.evidenceRefs.every((reference) => boundedString(reference, 500))
		&& validOptionalSummary(value.result) && validOptionalSummary(value.failure);
}
function validMetrics(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["workflowMs", "categories", "open", "incompleteIntervals", "incompleteCategories"])
		|| !nonNegativeInteger(value.workflowMs) || !nonNegativeInteger(value.incompleteIntervals)
		|| !boundedArray(value.incompleteCategories, WORKFLOW_METRIC_CATEGORIES.length)
		|| value.incompleteCategories.some((category) => !oneOf(category, WORKFLOW_METRIC_CATEGORIES))
		|| new Set(value.incompleteCategories).size !== value.incompleteCategories.length) return false;
	const categories = value.categories;
	if (!record(categories) || Object.keys(categories).length !== WORKFLOW_METRIC_CATEGORIES.length
		|| !Object.keys(categories).every((category) => (WORKFLOW_METRIC_CATEGORIES as readonly string[]).includes(category))
		|| !WORKFLOW_METRIC_CATEGORIES.every((category) => nonNegativeInteger(categories[category]))) return false;
	const total = WORKFLOW_METRIC_CATEGORIES.reduce((sum, category) => sum + (categories[category] as number), 0);
	if (total !== value.workflowMs) return false;
	return value.open === undefined || (record(value.open) && onlyKeys(value.open, ["category", "since"]) && oneOf(value.open.category, WORKFLOW_METRIC_CATEGORIES)
		&& boundedString(value.open.since, 80) && Number.isFinite(Date.parse(value.open.since)));
}
function validGit(value: unknown): boolean {
	return record(value) && onlyKeys(value, ["canonicalBranch", "baseCommit", "integrationBranch", "integrationWorktree"])
		&& boundedString(value.canonicalBranch, 500) && boundedString(value.baseCommit, 200)
		&& (value.integrationBranch === undefined || boundedString(value.integrationBranch, 500))
		&& (value.integrationWorktree === undefined || boundedString(value.integrationWorktree, 2_000));
}
function validDigest(value: unknown): value is string {
	return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}
function validContracts(value: unknown): boolean {
	if (!record(value) || !onlyKeys(value, ["story", "plan", "tasks"]) || !validDigest(value.story) || !validDigest(value.plan) || !record(value.tasks)) return false;
	const entries = Object.entries(value.tasks);
	return entries.length <= 200 && entries.every(([id, digest]) => STORY_ID.test(id) && validDigest(digest));
}
function validStateShape(state: Record<string, unknown>): boolean {
	return onlyKeys(state, ["schemaVersion", "storyId", "status", "activationOwner", "attention", "contracts", "git", "stages", "finalReview", "e2e", "metrics", "outcomeStatus"])
		&& oneOf(state.status, ["ready", "running", "paused", "attention", "completed", "failed", "stopped"])
		&& (state.activationOwner === undefined || validOwner(state.activationOwner)) && validOptionalSummary(state.attention)
		&& validContracts(state.contracts) && validGit(state.git) && validMetrics(state.metrics) && boundedArray(state.stages, 100)
		&& state.stages.every((stage) => record(stage) && onlyKeys(stage, ["id", "status", "tasks", "integration", "verification", "review"])
			&& typeof stage.id === "string" && STORY_ID.test(stage.id) && oneOf(stage.status, ["pending", "running", "completed", "attention"])
			&& boundedArray(stage.tasks, 200) && stage.tasks.every(validTask) && validIntegration(stage.integration)
			&& validVerification(stage.verification) && validReview(stage.review))
		&& validReview(state.finalReview) && validE2E(state.e2e)
		&& (state.outcomeStatus === undefined || oneOf(state.outcomeStatus, ["pending", "written", "failed"]));
}
export function parseStoryRuntimeState(value: unknown, storyId: string): StoryRuntimeState {
	if (!record(value) || value.schemaVersion !== 1 || value.storyId !== storyId || !validStateShape(value)) {
		throw new Error(`Unsupported or invalid runtime state for ${storyId}`);
	}
	return value as unknown as StoryRuntimeState;
}

const validateState = parseStoryRuntimeState;

function validateLedgerEntry(entry: LedgerEntry): void {
	if (!record(entry) || !onlyKeys(entry as unknown as Record<string, unknown>, ["id", "summary", "sourceRole", "updatedAt", "evidence"])) throw new Error("Ledger entries contain unsupported fields");
	if (typeof entry.id !== "string" || !entry.id.trim() || entry.id.length > 120 || typeof entry.summary !== "string" || !entry.summary.trim() || entry.summary.length > 2_000) throw new Error("Ledger entries require a bounded id and summary");
	if (typeof entry.sourceRole !== "string" || !entry.sourceRole.trim() || entry.sourceRole.length > 80 || typeof entry.updatedAt !== "string" || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error("Ledger entries require a role and timestamp");
	if (entry.evidence !== undefined && (!Array.isArray(entry.evidence) || entry.evidence.length > 16 || entry.evidence.some((reference) => typeof reference !== "string" || reference.length > 500 || reference.includes("\0")))) throw new Error("Ledger evidence references exceed their bound");
}

function validateLedger(value: unknown, storyId: string): StoryLedger {
	if (!value || typeof value !== "object") throw new Error(`Invalid workflow ledger for ${storyId}`);
	const ledger = value as Partial<StoryLedger>;
	if (!onlyKeys(value as Record<string, unknown>, ["schemaVersion", "entries"]) || ledger.schemaVersion !== 1 || !Array.isArray(ledger.entries)) throw new Error(`Invalid workflow ledger for ${storyId}`);
	for (const entry of ledger.entries) validateLedgerEntry(entry);
	return ledger as StoryLedger;
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum?: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value < 1) throw new Error("Store bounds must be positive integers");
	return maximum === undefined ? value : Math.min(value, maximum);
}

export class StoryRuntimeStore {
	readonly storyRoot: string;
	readonly statePath: string;
	readonly ledgerPath: string;
	readonly eventsPath: string;
	readonly #storyId: string;
	readonly #maxLedgerEntries: number;
	readonly #maxDebugTailEntries: number;
	readonly #maxDebugReadBytes: number;
	readonly #now: () => Date;
	#tail: Promise<void> = Promise.resolve();

	constructor(repositoryRoot: string, storyId: string, options: StoryRuntimeStoreOptions = {}) {
		if (!STORY_ID.test(storyId)) throw new Error("Invalid story identity");
		this.#storyId = storyId;
		this.storyRoot = join(repositoryRoot, "agent-artifacts", storyId);
		this.statePath = join(this.storyRoot, "state.yaml");
		this.ledgerPath = join(this.storyRoot, "ledger.yaml");
		this.eventsPath = join(this.storyRoot, "events.jsonl");
		this.#maxLedgerEntries = boundedPositiveInteger(options.maxLedgerEntries, DEFAULT_MAX_LEDGER_ENTRIES, ABSOLUTE_MAX_LEDGER_ENTRIES);
		this.#maxDebugTailEntries = boundedPositiveInteger(options.maxDebugTailEntries, DEFAULT_MAX_DEBUG_TAIL_ENTRIES, ABSOLUTE_MAX_DEBUG_TAIL_ENTRIES);
		this.#maxDebugReadBytes = boundedPositiveInteger(options.maxDebugReadBytes, DEFAULT_MAX_DEBUG_READ_BYTES);
		this.#now = options.now ?? (() => new Date());
	}

	async readState(): Promise<StoryRuntimeState | undefined> {
		await this.#tail;
		return this.#readStateUnlocked();
	}

	async writeState(state: StoryRuntimeState, event?: StoryDebugEvent): Promise<StoryStateWriteResult> {
		return this.#serialize(() => this.#commitStateUnlocked(state, event));
	}

	async updateState(update: (current: StoryRuntimeState | undefined) => StoryRuntimeState, event?: StoryDebugEvent | ((state: StoryRuntimeState) => StoryDebugEvent | undefined)): Promise<StoryStateWriteResult> {
		return this.#serialize(async () => {
			const current = await this.#readStateUnlocked();
			const state = update(current);
			if (current && state === current) return { state, stateWritten: false, debugEventAppended: false };
			return this.#commitStateUnlocked(state, typeof event === "function" ? event(state) : event);
		});
	}

	async readLedger(): Promise<StoryLedger> {
		await this.#tail;
		return this.#readLedgerUnlocked();
	}

	async upsertLedger(entry: LedgerEntry): Promise<StoryLedger> {
		return this.#serialize(async () => {
			validateLedgerEntry(entry);
			const current = await this.#readLedgerUnlocked();
			const entries = current.entries.filter((candidate) => candidate.id !== entry.id);
			entries.push(structuredClone(entry));
			const ledger: StoryLedger = { schemaVersion: 1, entries: entries.slice(-this.#maxLedgerEntries) };
			await atomicWriteFile(this.ledgerPath, stringify(ledger), 0o600);
			return ledger;
		});
	}

	async pruneLedger(ids: readonly string[]): Promise<StoryLedger> {
		return this.#serialize(async () => {
			const removed = new Set(ids);
			const current = await this.#readLedgerUnlocked();
			const ledger: StoryLedger = { schemaVersion: 1, entries: current.entries.filter((entry) => !removed.has(entry.id)) };
			await atomicWriteFile(this.ledgerPath, stringify(ledger), 0o600);
			return ledger;
		});
	}

	async appendDebug(event: StoryDebugEvent): Promise<boolean> {
		return this.#serialize(() => this.#appendDebugBestEffort(event));
	}

	async readDebugTail(limit = this.#maxDebugTailEntries, filter: DebugTailFilter = {}): Promise<StoredStoryDebugEvent[]> {
		await this.#tail;
		const boundedLimit = Math.min(boundedPositiveInteger(limit, this.#maxDebugTailEntries), this.#maxDebugTailEntries, ABSOLUTE_MAX_DEBUG_TAIL_ENTRIES);
		const fileStat = await stat(this.eventsPath).catch((error: unknown) => {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		});
		if (!fileStat) return [];
		const offset = Math.max(0, fileStat.size - this.#maxDebugReadBytes);
		const handle = await open(this.eventsPath, "r");
		let content: string;
		try {
			const buffer = Buffer.alloc(fileStat.size - offset);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
			content = buffer.subarray(0, bytesRead).toString("utf8");
		} finally { await handle.close(); }
		const lines = content.split("\n");
		if (offset > 0) lines.shift(); // the bounded read may begin in the middle of an event
		const types = filter.types && new Set(filter.types);
		const resultCodes = filter.resultCodes && new Set(filter.resultCodes);
		const events: StoredStoryDebugEvent[] = [];
		for (const line of lines) {
			if (!line.trim()) continue;
			let event: StoredStoryDebugEvent;
			try { event = JSON.parse(line) as StoredStoryDebugEvent; }
			catch { continue; } // a crash may leave a malformed trailing debug line
			if (event.storyId !== this.#storyId || typeof event.type !== "string" || typeof event.at !== "string") continue;
			if (types && !types.has(event.type)) continue;
			if (filter.stageId !== undefined && event.stageId !== filter.stageId) continue;
			if (filter.taskId !== undefined && event.taskId !== filter.taskId) continue;
			if (resultCodes && (!event.resultCode || !resultCodes.has(event.resultCode))) continue;
			events.push(event);
		}
		return events.slice(-boundedLimit);
	}

	async #readStateUnlocked(): Promise<StoryRuntimeState | undefined> {
		const content = await readTextIfExists(this.statePath);
		return content === undefined ? undefined : validateState(parse(content), this.#storyId);
	}

	async #readLedgerUnlocked(): Promise<StoryLedger> {
		const content = await readTextIfExists(this.ledgerPath);
		return content === undefined ? { schemaVersion: 1, entries: [] } : validateLedger(parse(content), this.#storyId);
	}

	async #commitStateUnlocked(state: StoryRuntimeState, event?: StoryDebugEvent): Promise<StoryStateWriteResult> {
		validateState(state, this.#storyId);
		await atomicWriteFile(this.statePath, stringify(state), 0o600);
		const debugEventAppended = event ? await this.#appendDebugBestEffort(event) : false;
		return { state, stateWritten: true, debugEventAppended };
	}

	async #appendDebugBestEffort(event: StoryDebugEvent): Promise<boolean> {
		try {
			const compact = (value: string, label: string, maximum: number, pattern: RegExp): string => {
				if (value.length > maximum || !pattern.test(value)) throw new Error(`Invalid debug ${label}`);
				return value;
			};
			const identifier = (value: string, label: string) => compact(value, label, 200, /^[^\r\n\0]+$/);
			const token = (value: string, label: string) => compact(value, label, 80, /^[a-z0-9][a-z0-9._-]*$/i);
			const numeric = (value: number, label: string): number => {
				if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid debug ${label}`);
				return value;
			};
			const usage = event.usage && {
				...(event.usage.inputTokens === undefined ? {} : { inputTokens: numeric(event.usage.inputTokens, "input usage") }),
				...(event.usage.outputTokens === undefined ? {} : { outputTokens: numeric(event.usage.outputTokens, "output usage") }),
				...(event.usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: numeric(event.usage.cacheReadTokens, "cache-read usage") }),
				...(event.usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: numeric(event.usage.cacheWriteTokens, "cache-write usage") }),
			};
			const route = event.route && {
				provider: compact(event.route.provider, "provider", 128, /^[a-z0-9][a-z0-9._/-]*$/i),
				model: compact(event.route.model, "model", 128, /^[a-z0-9][a-z0-9._/#:-]*$/i),
				...(event.route.effort === undefined ? {} : { effort: token(event.route.effort, "effort") }),
			};
			const stored: StoredStoryDebugEvent = {
				at: this.#now().toISOString(),
				storyId: this.#storyId,
				type: compact(event.type, "type", 80, /^[a-z0-9][a-z0-9._-]*$/),
				...(event.stageId === undefined ? {} : { stageId: identifier(event.stageId, "stage id") }),
				...(event.taskId === undefined ? {} : { taskId: identifier(event.taskId, "task id") }),
				...(event.slotId === undefined ? {} : { slotId: identifier(event.slotId, "slot id") }),
				...(event.attemptToken === undefined ? {} : { attemptToken: identifier(event.attemptToken, "attempt token") }),
				...(event.durationMs === undefined ? {} : { durationMs: numeric(event.durationMs, "duration") }),
				...(route === undefined ? {} : { route }),
				...(usage === undefined ? {} : { usage }),
				...(event.resultCode === undefined ? {} : { resultCode: token(event.resultCode, "result code") }),
			};
			await mkdir(this.storyRoot, { recursive: true, mode: 0o700 });
			const handle = await open(this.eventsPath, "a+", 0o600);
			try {
				const size = (await handle.stat()).size;
				let prefix = "";
				if (size > 0) {
					const finalByte = Buffer.alloc(1);
					await handle.read(finalByte, 0, 1, size - 1);
					if (finalByte[0] !== 0x0a) prefix = "\n";
				}
				await handle.writeFile(`${prefix}${JSON.stringify(stored)}\n`, "utf8");
				await handle.sync();
			} finally { await handle.close(); }
			return true;
		} catch { return false; }
	}

	#serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.#tail.then(operation);
		this.#tail = result.then(() => undefined, () => undefined);
		return result;
	}
}
