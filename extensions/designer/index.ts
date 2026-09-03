import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSkillsForPrompt, type BeforeAgentStartEvent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { currentWorkMode } from "../work-mode/runtime.js";
import { isSubagentRuntime } from "../core/runtime-role.js";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROMPT_PATH = resolve(PACKAGE_ROOT, "prompt/designer.md");
export const DESIGNER_HANDOFF_SKILL_PATH = resolve(PACKAGE_ROOT, "skills/designer-handoff/SKILL.md");
const REQUIRED_TOOL = "subagent_spawn";
const PRODUCT_SKILLS = new Set(["product-discussion", "shape-story", "plan-delivery", "workflow-run"]);
const DESIGNER_SKILL = "designer-handoff";

export interface DesignAuthoritySnapshot {
	path: string;
	content: string;
}

export function repositoryRoot(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

/** Find one closest DESIGN.md from cwd up to and including the repository root. */
export function loadClosestDesignAuthority(cwd: string): DesignAuthoritySnapshot | undefined {
	const root = repositoryRoot(cwd);
	let current = resolve(cwd);
	while (true) {
		const path = join(current, "DESIGN.md");
		if (existsSync(path)) return { path, content: readFileSync(path, "utf8") };
		if (current === root) return undefined;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

function renderAuthority(authority: DesignAuthoritySnapshot, cwd: string): string {
	const displayPath = relative(cwd, authority.path).replaceAll("\\", "/") || "DESIGN.md";
	return ["# Repository Design Authority", `Source: ${displayPath}`, "", authority.content.trim()].join("\n");
}

function filterSkillCatalog(event: BeforeAgentStartEvent, keep: (name: string) => boolean): string {
	const skills = event.systemPromptOptions.skills ?? [];
	const originalCatalog = formatSkillsForPrompt(skills);
	if (!originalCatalog) return event.systemPrompt;
	return event.systemPrompt.replace(originalCatalog, formatSkillsForPrompt(skills.filter((skill) => keep(skill.name))));
}

export function hideDesignerSkills(event: BeforeAgentStartEvent): string {
	return filterSkillCatalog(event, (name) => !PRODUCT_SKILLS.has(name));
}

export function hideDesignerHandoffSkill(event: BeforeAgentStartEvent): string {
	return filterSkillCatalog(event, (name) => name !== DESIGNER_SKILL);
}

function ensureDesignerCapability(pi: ExtensionAPI): void {
	if (!pi.getAllTools().some((tool) => tool.name === REQUIRED_TOOL)) throw new Error(`Designer mode requires the ${REQUIRED_TOOL} tool.`);
	if (!pi.getActiveTools().includes(REQUIRED_TOOL)) throw new Error(`Designer mode requires the active ${REQUIRED_TOOL} tool. Adjust the Pi tool allowlist before continuing.`);
}

export default function designerExtension(pi: ExtensionAPI): void {
	if (isSubagentRuntime(process.env)) return;
	let prompt: string | undefined;
	let authority: DesignAuthoritySnapshot | undefined;
	let snapshotCwd: string | undefined;

	const ensureSnapshot = (cwd: string) => {
		if (snapshotCwd === cwd && prompt !== undefined) return;
		snapshotCwd = cwd;
		prompt = readFileSync(PROMPT_PATH, "utf8").trim();
		authority = loadClosestDesignAuthority(cwd);
	};

	pi.on("resources_discover", () => ({ skillPaths: [DESIGNER_HANDOFF_SKILL_PATH] }));
	pi.on("input", (event, ctx) => {
		if (!/^\/skill:designer-handoff(?:\s|$)/.test(event.text) || currentWorkMode() === "designer") return;
		ctx.ui.notify("The designer-handoff skill is available only in PiBox Designer mode. Switch modes, then retry.", "warning");
		return { action: "handled" };
	});
	pi.on("before_agent_start", (event, ctx) => {
		if (currentWorkMode() !== "designer") return { systemPrompt: hideDesignerHandoffSkill(event) };
		ensureDesignerCapability(pi);
		ensureSnapshot(ctx.cwd);
		const additions = [prompt!];
		if (authority) additions.push(renderAuthority(authority, ctx.cwd));
		return { systemPrompt: `${hideDesignerSkills(event)}\n\n${additions.join("\n\n")}` };
	});
	pi.on("session_shutdown", () => {
		prompt = undefined;
		authority = undefined;
		snapshotCwd = undefined;
	});
}
