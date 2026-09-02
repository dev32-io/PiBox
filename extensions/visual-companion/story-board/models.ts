export interface Diagnostic {
	path: string;
	message: string;
}

export type TaskColumn = "To do" | "In progress" | "Done";

export interface StorySummary {
	id: string;
	title: string;
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
	attempt: number;
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

export interface StoryWorkspace {
	story: StorySummary;
	columns: Record<TaskColumn, TaskCard[]>;
	tasks: TaskCard[];
	documentGroups: Array<{ group: DocumentGroup; documents: DocumentSummary[] }>;
	reports: ReportSummary[];
	diagnostics: Diagnostic[];
}
