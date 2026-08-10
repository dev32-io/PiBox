export type HarnessErrorCode =
	| "CAPABILITY_DENIED"
	| "CONFIG_INVALID"
	| "DIRTY_CANONICAL_BRANCH"
	| "GIT_OPERATION_FAILED"
	| "INVALID_ARTIFACT"
	| "INVALID_HANDOFF"
	| "MODEL_UNAVAILABLE"
	| "NOT_A_GIT_REPOSITORY"
	| "RESOURCE_LOCKED"
	| "STALE_PLANNING_REVISION"
	| "WORK_ITEM_EXISTS"
	| "WORK_ITEM_NOT_FOUND";

export class HarnessError extends Error {
	readonly code: HarnessErrorCode;
	readonly details: Record<string, unknown>;

	constructor(code: HarnessErrorCode, message: string, details: Record<string, unknown> = {}) {
		super(message);
		this.name = "HarnessError";
		this.code = code;
		this.details = details;
	}
}

export function describeHarnessError(error: unknown): string {
	if (error instanceof HarnessError) return `${error.code}: ${error.message}`;
	return error instanceof Error ? error.message : String(error);
}
