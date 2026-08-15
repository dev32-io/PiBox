import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { LoadedPermissionPolicy, PermissionDecision, PermissionEvaluation, PermissionPolicyFile } from "./types.js";

export const PERMISSION_POLICY_RELATIVE_PATH = ".pi/permissions.yaml";
const DECISIONS = new Set<PermissionDecision>(["allow", "ask", "deny"]);
const PATH_TOOLS: Record<string, string> = { read: "Read", write: "Write", edit: "Edit", ls: "Ls", find: "Find", grep: "Grep" };

interface Subject {
	kind: string;
	targets: string[];
	summary: string;
}

interface ParsedRule {
	kind: string;
	pattern?: string;
}

function asStringArray(value: unknown, label: string, issues: string[]): string[] {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
		issues.push(`${label} must be an array of non-empty strings`);
		return [];
	}
	return value.map((entry) => String(entry).trim());
}

export function loadPermissionPolicy(cwd: string): LoadedPermissionPolicy {
	const path = resolve(cwd, PERMISSION_POLICY_RELATIVE_PATH);
	if (!existsSync(path)) return { path, defaultDecision: "allow", allow: [], ask: [], deny: [], issues: [] };
	const issues: string[] = [];
	let parsed: PermissionPolicyFile;
	try {
		const value = parseYaml(readFileSync(path, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return { path, defaultDecision: "deny", allow: [], ask: [], deny: [], issues: ["policy root must be an object"] };
		parsed = value as PermissionPolicyFile;
	} catch (error) {
		return { path, defaultDecision: "deny", allow: [], ask: [], deny: [], issues: [`Invalid YAML: ${error instanceof Error ? error.message : String(error)}`] };
	}
	if (parsed.version !== undefined && parsed.version !== 1) issues.push("version must be 1");
	const defaultDecision = parsed.default ?? "ask";
	if (!DECISIONS.has(defaultDecision)) issues.push("default must be allow, ask, or deny");
	const permissions = parsed.permissions ?? {};
	if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) issues.push("permissions must be an object");
	const allow = asStringArray(permissions.allow, "permissions.allow", issues);
	const ask = asStringArray(permissions.ask, "permissions.ask", issues);
	const deny = asStringArray(permissions.deny, "permissions.deny", issues);
	return { path, defaultDecision: issues.length > 0 ? "deny" : defaultDecision, allow, ask, deny, issues };
}

function parseRule(rule: string): ParsedRule | undefined {
	const match = /^([A-Za-z][A-Za-z0-9_-]*)(?:\((.*)\))?$/.exec(rule.trim());
	if (!match?.[1]) return undefined;
	return { kind: match[1].toLowerCase(), ...(match[2] !== undefined ? { pattern: match[2] } : {}) };
}

function expandPattern(pattern: string, cwd: string): string {
	const home = homedir();
	return pattern
		.replaceAll("${workspace}", cwd)
		.replaceAll("${repository}", cwd)
		.replaceAll("${home}", home)
		.replaceAll("${tmp}", process.env.TMPDIR ?? "/tmp")
		.replace(/^~(?=\/|$)/, home);
}

function globRegex(pattern: string): RegExp {
	let source = "";
	for (const character of pattern) {
		if (character === "*") source += ".*";
		else if (character === "?") source += ".";
		else source += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
	}
	return new RegExp(`^${source}$`);
}

function matchesRule(rule: string, subject: Subject, cwd: string): boolean {
	const parsed = parseRule(rule);
	if (!parsed || (parsed.kind !== subject.kind.toLowerCase() && parsed.kind !== "tool")) return false;
	if (parsed.kind === "tool" && subject.kind.toLowerCase() !== "tool") return false;
	if (parsed.pattern === undefined) return true;
	const regex = globRegex(expandPattern(parsed.pattern, cwd));
	return subject.targets.some((target) => regex.test(target));
}

function pathTargets(rawPath: string, cwd: string): string[] {
	const absolute = isAbsolute(rawPath) ? resolve(rawPath) : resolve(cwd, rawPath);
	const rel = relative(cwd, absolute).replaceAll("\\", "/");
	return [...new Set([rawPath, absolute, rel ? `./${rel}` : ".", rel])].filter(Boolean);
}

function splitSimpleShell(command: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const character = command[index]!;
		if (escaped) { current += character; escaped = false; continue; }
		if (character === "\\") { current += character; escaped = true; continue; }
		if (quote) {
			current += character;
			if (character === quote) quote = undefined;
			continue;
		}
		if (character === "'" || character === '"') { quote = character; current += character; continue; }
		const pair = command.slice(index, index + 2);
		if (pair === "&&" || pair === "||") {
			if (current.trim()) parts.push(current.trim());
			current = ""; index++; continue;
		}
		if (character === ";" || character === "|") {
			if (current.trim()) parts.push(current.trim());
			current = ""; continue;
		}
		current += character;
	}
	if (current.trim()) parts.push(current.trim());
	return parts.length > 0 ? parts : [command.trim()];
}

function subjectsForTool(toolName: string, input: Record<string, unknown>, cwd: string): Subject[] {
	const lower = toolName.toLowerCase();
	if (lower === "bash") {
		const command = typeof input.command === "string" ? input.command : "";
		return splitSimpleShell(command).map((part) => ({ kind: "bash", targets: [part], summary: `Bash(${part})` }));
	}
	const pathKind = PATH_TOOLS[lower];
	if (pathKind) {
		const rawPath = typeof input.path === "string" ? input.path : ".";
		return [{ kind: pathKind.toLowerCase(), targets: pathTargets(rawPath, cwd), summary: `${pathKind}(${rawPath})` }];
	}
	if (lower === "mcp") {
		const server = typeof input.server === "string" ? input.server : "";
		const tool = typeof input.tool === "string" ? input.tool : "";
		const target = [server, tool].filter(Boolean).join("/") || "unknown";
		return [{ kind: "mcp", targets: [target, server, tool].filter(Boolean), summary: `Mcp(${target})` }];
	}
	return [{ kind: "tool", targets: [toolName], summary: `Tool(${toolName})` }];
}

const RANK: Record<PermissionDecision, number> = { allow: 0, ask: 1, deny: 2 };

function evaluateSubject(policy: LoadedPermissionPolicy, subject: Subject, cwd: string): PermissionEvaluation {
	let decision = policy.defaultDecision;
	let matchedRule: string | undefined;
	for (const [candidate, rules] of [["allow", policy.allow], ["ask", policy.ask], ["deny", policy.deny]] as const) {
		for (const rule of rules) {
			if (!matchesRule(rule, subject, cwd)) continue;
			if (RANK[candidate] >= RANK[decision] || matchedRule === undefined) {
				decision = candidate;
				matchedRule = rule;
			}
		}
	}
	return { decision, summary: subject.summary, ...(matchedRule ? { matchedRule } : {}) };
}

export function evaluateToolCall(policy: LoadedPermissionPolicy, toolName: string, input: Record<string, unknown>, cwd: string): PermissionEvaluation {
	const policyPath = resolve(cwd, PERMISSION_POLICY_RELATIVE_PATH);
	if ((toolName === "write" || toolName === "edit") && typeof input.path === "string" && resolve(cwd, input.path) === policyPath) {
		return { decision: "deny", summary: `${PATH_TOOLS[toolName]}(${input.path})`, matchedRule: "protected permission policy" };
	}
	if (toolName === "bash" && typeof input.command === "string" && /(?:^|[\s'"/])\.pi\/permissions\.ya?ml(?:$|[\s'";|&])/.test(input.command)) {
		return { decision: "deny", summary: `Bash(${input.command})`, matchedRule: "protected permission policy" };
	}
	const evaluations = subjectsForTool(toolName, input, cwd).map((subject) => evaluateSubject(policy, subject, cwd));
	return evaluations.reduce((strictest, candidate) => RANK[candidate.decision] > RANK[strictest.decision] ? candidate : strictest);
}
