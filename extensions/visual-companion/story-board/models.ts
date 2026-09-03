export interface Diagnostic {
	path: string;
	message: string;
}

export type TaskColumn = "To do" | "In progress" | "Done";

export interface StorySummary {
	id: string;
	title: string;
	format?: "current" | "legacy";
	intentExcerpt: string;
	kind: string;
	phase: string;
	state: string;
	planningRevision?: number;
	taskCount: number;
	reportCount: number;
	degraded: boolean;
	diagnostics: Diagnostic[];
}

export interface TaskCard {
	id: string;
	title: string;
	status: string;
	column: TaskColumn;
	dependsOn: string[];
	stage?: string;
	relatedReportIds: string[];
	degraded: boolean;
	diagnostics: Diagnostic[];
}

export interface DeliveryHistory {
	executionMode?: "repository" | "worktree";
	completedCommit?: string;
	mergedCommit?: string;
}

export interface TaskDetail extends TaskCard {
	brief?: string;
	scope?: string;
	delivery?: string;
	acceptance?: string;
	assignment?: { agent: string; tier?: string; rationale?: string };
	verification: { methods: string[]; taskChecks: string[] };
	deliveryHistory?: DeliveryHistory;
}

export type DocumentGroup = "Intent and scope" | "Specifications" | "Design" | "Decisions" | "Journey cases" | "Outcome";

export interface DocumentSummary {
	id: string;
	title: string;
	type: string;
	group: DocumentGroup;
	path: string;
	status: string;
	available: boolean;
	diagnostics: Diagnostic[];
}

export interface DocumentDetail extends DocumentSummary {
	body?: string;
}

export interface Finding {
	id: string;
	severity: string;
	status: string;
	summary: string;
	blocking?: boolean;
	location?: string;
}

export interface EvidenceMetadata {
	id: string;
	path?: string;
	/** Canonical story-relative member used by the current evidence route. */
	memberPath?: string;
	result?: string;
	description?: string;
	command?: string;
	checksum?: string;
	mediaType?: string;
	manifestMember: boolean;
	available: boolean;
	supported: boolean;
	diagnostics: Diagnostic[];
}

export interface ReportSummary {
	id: string;
	type: string;
	status: string;
	verdict?: string;
	attempt?: number;
	scope: { kind: "task" | "stage" | "story" | "final" | "e2e" | "unknown"; id?: string };
	taskId?: string;
	findingCount: number;
	hasRiskAcceptance: boolean;
	available: boolean;
	diagnostics: Diagnostic[];
}

export interface ReportDetail extends ReportSummary {
	body?: string;
	findings: Finding[];
	riskAcceptance?: string;
	history: Array<{ attempt: number; path: string; body?: string; available: boolean }>;
	evidence: EvidenceMetadata[];
	caseResults?: Array<{ caseId: string; status: string; executedActions: string[]; observations: string[]; evidenceRefs: string[] }>;
}

export interface CheckAggregate {
	passed: number;
	failed: number;
	running: number;
	total: number;
}

export interface FindingCounts {
	critical: number;
	major: number;
	minor: number;
	total: number;
}

export interface RuntimeSummaryProjection {
	code: string;
	summary: string;
}

export type WorkflowTimingCategory = "implementation" | "integration" | "verification" | "review" | "e2e";

export interface StageTimingProjection {
	workflowMs: number;
	categories: Record<WorkflowTimingCategory, number>;
	incompleteIntervals: number;
	incompleteCategories: WorkflowTimingCategory[];
	activeCategory?: WorkflowTimingCategory;
	activeSince?: string;
}

export interface WorkflowMetricsProjection extends StageTimingProjection {
	activeStageId?: string;
	stageBreakdown?: Record<string, StageTimingProjection>;
}

export interface WorkflowOverview {
	status: string;
	outcomeStatus?: string;
	totals: {
		tasks: { completed: number; total: number; active: number; attention: number };
		repairs: number;
		checks: CheckAggregate;
		findings: FindingCounts;
	};
	attention: { tasks: number; checks: number; findings: number; total: number };
	currentStageId?: string;
	currentPhase?: "implementation" | "integration" | "verification" | "review" | "e2e";
	evidenceCount: number;
	metrics: WorkflowMetricsProjection;
	topAttention?: RuntimeSummaryProjection;
}

export interface StageTaskProjection {
	id: string;
	title: string;
	status: string;
	dependsOn: string[];
	incompleteDependencyCount: number;
	repairCount: number;
	checks: CheckAggregate;
	result?: RuntimeSummaryProjection;
	failure?: RuntimeSummaryProjection;
	reportId?: string;
}

export interface StageOperationProjection {
	status: string;
	repairCount: number;
	checks?: CheckAggregate;
	findings?: FindingCounts;
	result?: RuntimeSummaryProjection;
	failure?: RuntimeSummaryProjection;
	reportId?: string;
}

export interface StageProjection {
	id: string;
	mode: "sequential" | "concurrent" | "unknown";
	status: string;
	taskIds: string[];
	tasks: StageTaskProjection[];
	progress: { completed: number; total: number };
	integration: StageOperationProjection;
	verification: StageOperationProjection;
	review: StageOperationProjection;
	timing?: StageTimingProjection;
}

export interface StoryWorkspace {
	story: StorySummary;
	workflow?: WorkflowOverview;
	stages?: StageProjection[];
	finalReview?: StageOperationProjection;
	finalE2E?: StageOperationProjection;
	columns: Record<TaskColumn, TaskCard[]>;
	tasks: TaskCard[];
	documentGroups: Array<{ group: DocumentGroup; documents: DocumentSummary[] }>;
	reports: ReportSummary[];
	diagnostics: Diagnostic[];
}
