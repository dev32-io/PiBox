import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatSkillsForPrompt, type BeforeAgentStartEvent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { activeProfile, registerProfile } from "../profile/registry.js";

const DESIGNER_PROFILE = "designer";
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROMPT_PATH = resolve(PACKAGE_ROOT, "prompt/designer.md");
const HANDOFF_SKILL_PATH = resolve(PACKAGE_ROOT, "skills/designer-handoff/SKILL.md");
const REQUIRED_TOOL = "subagent_spawn";
const HIDDEN_SKILLS = new Set(["product-discussion", "shape-story", "plan-delivery", "workflow-run"]);

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
	return [
		"# Repository Design Authority",
		`Source: ${displayPath}`,
		"",
		authority.content.trim(),
	].join("\n");
}

export function hideDesignerSkills(event: BeforeAgentStartEvent): string {
	const skills = event.systemPromptOptions.skills ?? [];
	const originalCatalog = formatSkillsForPrompt(skills);
	if (!originalCatalog) return event.systemPrompt;
	const designerCatalog = formatSkillsForPrompt(skills.filter((skill) => !HIDDEN_SKILLS.has(skill.name)));
	return event.systemPrompt.replace(originalCatalog, designerCatalog);
}

function ensureDesignerTools(pi: ExtensionAPI): void {
	if (!pi.getAllTools().some((tool) => tool.name === REQUIRED_TOOL)) {
		throw new Error(`Designer profile requires the ${REQUIRED_TOOL} tool.`);
	}
	const activeTools = pi.getActiveTools();
	if (!activeTools.includes(REQUIRED_TOOL)) pi.setActiveTools([...activeTools, REQUIRED_TOOL]);
}

export default function designerExtension(pi: ExtensionAPI): void {
	registerProfile(DESIGNER_PROFILE);
	let active = false;
	let prompt = "";
	let authority: DesignAuthoritySnapshot | undefined;
	let cwd = "";

	pi.on("session_start", (_event, ctx) => {
		active = activeProfile() === DESIGNER_PROFILE;
		if (!active) return;
		cwd = ctx.cwd;
		prompt = readFileSync(PROMPT_PATH, "utf8").trim();
		authority = loadClosestDesignAuthority(ctx.cwd);
		if (ctx.hasUI) {
			const detail = authority ? `designer · ${relative(ctx.cwd, authority.path).replaceAll("\\", "/") || "DESIGN.md"}` : "designer";
			ctx.ui.setStatus("pibox-designer", detail);
		}
	});

	pi.on("resources_discover", () => {
		if (!active) return;
		return { skillPaths: [HANDOFF_SKILL_PATH] };
	});

	pi.on("before_agent_start", (event) => {
		if (!active) return;
		ensureDesignerTools(pi);
		const additions = [prompt];
		if (authority) additions.push(renderAuthority(authority, cwd));
		return { systemPrompt: `${hideDesignerSkills(event)}\n\n${additions.join("\n\n")}` };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("pibox-designer", undefined);
		active = false;
		prompt = "";
		authority = undefined;
		cwd = "";
	});
}
