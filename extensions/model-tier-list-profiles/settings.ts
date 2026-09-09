import { constants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, rmdir, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	DEFAULT_MODEL_TIER_LIST_PROFILES,
	mergeModelTierProfileValues,
	resolveModelTierSettingsPath,
	validateModelTierListProfiles,
	type ModelTierListProfilesConfig,
	type ModelTierProfileSourceOptions,
} from "./profiles.js";

export interface InitializeModelTierListProfilesOptions extends Pick<ModelTierProfileSourceOptions, "agentDir" | "home"> {
	lockTimeoutMs?: number;
}

export interface ModelTierListProfilesInitialization {
	changed: boolean;
	path: string;
	config: ModelTierListProfilesConfig;
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSettings(raw: string, path: string): UnknownRecord {
	let parsed: unknown;
	try { parsed = JSON.parse(raw.replace(/^\uFEFF/, "")); }
	catch (error) { throw new Error(`${path}: malformed JSON: ${error instanceof Error ? error.message : String(error)}`); }
	if (!isRecord(parsed)) throw new Error(`${path}: settings must contain a JSON object`);
	return parsed;
}

function mergedSettingsProfiles(settings: UnknownRecord, path: string): ModelTierListProfilesConfig {
	if (settings.modelTierListProfiles === undefined) return structuredClone(DEFAULT_MODEL_TIER_LIST_PROFILES);
	if (!isRecord(settings.modelTierListProfiles)) throw new Error(`${path}: modelTierListProfiles must be a mapping`);
	try {
		return validateModelTierListProfiles(mergeModelTierProfileValues(DEFAULT_MODEL_TIER_LIST_PROFILES, settings.modelTierListProfiles));
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function acquireSettingsLock(path: string, timeoutMs: number): Promise<() => Promise<void>> {
	const lockPath = `${path}.lock`;
	const started = Date.now();
	while (true) {
		try {
			await mkdir(lockPath);
			let released = false;
			return async () => {
				if (released) return;
				released = true;
				await rmdir(lockPath);
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() - started >= timeoutMs) throw new Error(`Timed out waiting for Pi settings lock: ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

async function readCurrent(path: string): Promise<string | undefined> {
	try { return await readFile(path, "utf8"); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

async function atomicWrite(path: string, content: string, mode: number): Promise<void> {
	const directory = dirname(path);
	const temporary = join(directory, `.${basename(path)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
	let handle;
	try {
		handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, mode);
		await handle.writeFile(content, "utf8");
		await handle.sync();
		await handle.close();
		handle = undefined;
		await chmod(temporary, mode);
		await rename(temporary, path);
	} finally {
		await handle?.close().catch(() => {});
		await unlink(temporary).catch(() => {});
	}
}

/**
 * Materialize editable built-in tier defaults in Pi's official global settings.
 * This helper never reads repository policy and refuses to rewrite malformed or
 * invalid settings. The native-compatible settings.json.lock directory and a
 * same-directory atomic rename prevent partial files and coordinate writers.
 */
export async function initializeModelTierListProfilesSettings(
	options: InitializeModelTierListProfilesOptions = {},
): Promise<ModelTierListProfilesInitialization> {
	const path = resolveModelTierSettingsPath(options);
	const directory = dirname(path);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const release = await acquireSettingsLock(path, options.lockTimeoutMs ?? 2_000);
	try {
		const raw = await readCurrent(path);
		const settings = raw === undefined ? {} : parseSettings(raw, path);
		const config = mergedSettingsProfiles(settings, path);
		if (settings.modelTierListProfiles !== undefined) {
			try {
				const existing = validateModelTierListProfiles(settings.modelTierListProfiles);
				if (JSON.stringify(existing) === JSON.stringify(config)) return { changed: false, path, config };
			} catch {
				// A partial built-in override may become complete through inheritance.
			}
		}
		const next = `${JSON.stringify({ ...settings, modelTierListProfiles: config }, null, 2)}\n`;
		const mode = raw === undefined ? 0o600 : (await stat(path)).mode & 0o777;
		await atomicWrite(path, next, mode);
		return { changed: true, path, config };
	} finally {
		await release();
	}
}
