import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

export const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ModelThinkingLevel[];

export interface EffortConfig {
	default?: ModelThinkingLevel;
	models: Record<string, ModelThinkingLevel>;
}

export const DEFAULT_EFFORT_CONFIG: Readonly<EffortConfig> = { models: {} };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validLevel(value: unknown): ModelThinkingLevel | undefined {
	return typeof value === "string" && EFFORT_LEVELS.includes(value as ModelThinkingLevel) ? value as ModelThinkingLevel : undefined;
}

function readConfig(path: string): Partial<EffortConfig> {
	if (!existsSync(path)) return {};
	try {
		const value = parse(readFileSync(path, "utf8"));
		if (!isRecord(value)) return {};
		const models: Record<string, ModelThinkingLevel> = {};
		if (isRecord(value.models)) {
			for (const [model, level] of Object.entries(value.models)) {
				const valid = validLevel(level);
				if (valid) models[model] = valid;
			}
		}
		const defaultLevel = validLevel(value.default);
		return { ...(defaultLevel ? { default: defaultLevel } : {}), models };
	} catch {
		return {};
	}
}

/** User config is loaded first; repository config overrides it. */
export function loadEffortConfig(cwd: string): EffortConfig {
	const user = readConfig(join(homedir(), ".pi", "agent", "pibox", "effort.yaml"));
	const repository = readConfig(join(cwd, ".pi", "pibox-effort.yaml"));
	const defaultLevel = repository.default ?? user.default;
	return {
		...(defaultLevel ? { default: defaultLevel } : {}),
		models: { ...user.models, ...repository.models },
	};
}
