import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const BUILT_IN_AGENT_ROOT = resolve(REPOSITORY_ROOT, "agent-definitions");
export const BUILT_IN_PROMPT_ROOT = resolve(REPOSITORY_ROOT, "prompt");

export function readBuiltInPrompt(id: string): string {
	return readFileSync(resolve(BUILT_IN_PROMPT_ROOT, `${id}.md`), "utf8").trim();
}

export function renderBuiltInPrompt(id: string, values: Record<string, string | number> = {}): string {
	const source = readBuiltInPrompt(id);
	return source.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => {
		if (!(key in values)) throw new Error(`Missing prompt value ${key} for ${id}`);
		return String(values[key]);
	});
}
