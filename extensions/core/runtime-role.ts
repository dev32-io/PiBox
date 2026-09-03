/** Explicitly identifies bounded child Pi runtimes without relying on workflow metadata. */
export const PIBOX_RUNTIME_ROLE_ENV = "PIBOX_RUNTIME_ROLE";
export const PIBOX_SUBAGENT_RUNTIME_ROLE = "subagent";

/** Runtime role is the sole main-versus-child authority. Identity metadata never selects behavior. */
export function isSubagentRuntime(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[PIBOX_RUNTIME_ROLE_ENV] === PIBOX_SUBAGENT_RUNTIME_ROLE;
}
