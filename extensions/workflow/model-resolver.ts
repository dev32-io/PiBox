export {
	normalizeExplicitModelOverride,
	resolveSubagentModel as resolveHarnessModel,
	supportsEffort,
} from "../subagent/model-resolver.js";
export type {
	ExplicitModelOverride,
	ModelAttempt,
	ModelResolutionRequest,
	ResolvedSubagentModel as ResolvedHarnessModel,
	SubagentModelResolution as HarnessModelResolution,
	UnresolvedSubagentModel as UnresolvedHarnessModel,
} from "../subagent/model-resolver.js";
