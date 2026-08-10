export type FailureClass =
	| "model_unavailable"
	| "rate_limited"
	| "subscription_exhausted"
	| "authentication_required"
	| "provider_unavailable"
	| "network_interrupted"
	| "context_overflow"
	| "tool_failed"
	| "agent_aborted"
	| "process_crashed"
	| "protocol_failed"
	| "unknown_provider_error";

export interface FailureEvidence {
	httpStatus?: number;
	headers?: Record<string, string | undefined>;
	message?: string;
	stopReason?: string;
	exitCode?: number;
	aborted?: boolean;
	missingProtocol?: boolean;
}

export interface ClassifiedFailure {
	class: FailureClass;
	retryAfter?: string;
	capacityRelated: boolean;
}

export function classifyFailure(evidence: FailureEvidence): ClassifiedFailure {
	const message = (evidence.message ?? "").toLowerCase();
	const retryAfter = evidence.headers?.["retry-after"] ?? evidence.headers?.["x-ratelimit-reset"];
	if (evidence.missingProtocol) return { class: "protocol_failed", capacityRelated: false };
	if (evidence.aborted || evidence.stopReason === "aborted") return { class: "agent_aborted", capacityRelated: false };
	if (evidence.httpStatus === 401 || evidence.httpStatus === 403 || /authentication|api key|unauthori[sz]ed|login required/.test(message)) {
		return { class: "authentication_required", capacityRelated: false };
	}
	if (evidence.httpStatus === 429) {
		if (/subscription|weekly limit|quota exhausted|billing/.test(message)) return { class: "subscription_exhausted", ...(retryAfter ? { retryAfter } : {}), capacityRelated: true };
		return { class: "rate_limited", ...(retryAfter ? { retryAfter } : {}), capacityRelated: true };
	}
	if (/subscription|weekly limit|quota exhausted/.test(message)) return { class: "subscription_exhausted", capacityRelated: true };
	if (/context (window|length)|too many tokens|context overflow/.test(message)) return { class: "context_overflow", capacityRelated: false };
	if (/model.+(not found|unavailable)|unknown model/.test(message)) return { class: "model_unavailable", capacityRelated: false };
	if ((evidence.httpStatus !== undefined && evidence.httpStatus >= 500) || /provider unavailable|overloaded|capacity/.test(message)) {
		return { class: "provider_unavailable", ...(retryAfter ? { retryAfter } : {}), capacityRelated: true };
	}
	if (/econnreset|etimedout|network|socket hang up|fetch failed/.test(message)) return { class: "network_interrupted", capacityRelated: false };
	if (evidence.stopReason === "tool_error" || /tool.+failed/.test(message)) return { class: "tool_failed", capacityRelated: false };
	if (evidence.exitCode !== undefined && evidence.exitCode !== 0) return { class: "process_crashed", capacityRelated: false };
	return { class: "unknown_provider_error", capacityRelated: false };
}
