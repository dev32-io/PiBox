import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerProfile, selectedProfile } from "../profile/registry.js";

const DESIGNER_PROFILE = "designer";
const PROMPT_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../prompt/designer.md");

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

export default function designerExtension(pi: ExtensionAPI): void {
	registerProfile(DESIGNER_PROFILE);
	let active = false;
	let prompt = "";
	let authority: DesignAuthoritySnapshot | undefined;
	let cwd = "";

	pi.on("session_start", (_event, ctx) => {
		active = selectedProfile(pi) === DESIGNER_PROFILE;
		if (!active) return;
		cwd = ctx.cwd;
		prompt = readFileSync(PROMPT_PATH, "utf8").trim();
		authority = loadClosestDesignAuthority(ctx.cwd);
		if (ctx.hasUI) {
			const detail = authority ? `designer · ${relative(ctx.cwd, authority.path).replaceAll("\\", "/") || "DESIGN.md"}` : "designer";
			ctx.ui.setStatus("pibox-designer", detail);
		}
	});

	pi.on("before_agent_start", (event) => {
		if (!active) return;
		const additions = [prompt];
		if (authority) additions.push(renderAuthority(authority, cwd));
		return { systemPrompt: `${event.systemPrompt}\n\n${additions.join("\n\n")}` };
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setStatus("pibox-designer", undefined);
		active = false;
		prompt = "";
		authority = undefined;
		cwd = "";
	});
}
