export type PermissionMode = "enforce" | "bypass";
export type PermissionDecision = "allow" | "ask" | "deny";

export interface PermissionPolicyFile {
	version?: number;
	default?: PermissionDecision;
	permissions?: {
		allow?: string[];
		ask?: string[];
		deny?: string[];
	};
}

export interface LoadedPermissionPolicy {
	path: string;
	defaultDecision: PermissionDecision;
	allow: string[];
	ask: string[];
	deny: string[];
	issues: string[];
}

export interface PermissionEvaluation {
	decision: PermissionDecision;
	summary: string;
	matchedRule?: string;
}
