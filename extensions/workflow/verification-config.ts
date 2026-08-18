import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { parse } from "yaml";
import { HarnessError } from "./errors.js";
import type { NormalizedVerificationCheck } from "./verification-checks.js";

const NAME = /^[a-z0-9][a-z0-9-]*$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONFIG_PATH = ".pibox/verification.yaml";

export interface VerificationProfile {
	shell: string;
	bootstrap?: string;
	requiredEnvironment: string[];
}

export interface VerificationConfig {
	schemaVersion: 1;
	path: string;
	defaultProfile?: string;
	profiles: Record<string, VerificationProfile>;
}

export interface ResolvedVerificationProfile extends VerificationProfile {
	name: string;
	digest: string;
	legacy: boolean;
	configPath?: string;
}

function object(value: unknown, context: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("CONFIG_INVALID", `${context} must be an object`);
	return value as Record<string, unknown>;
}

function assertFields(record: Record<string, unknown>, allowed: string[], context: string): void {
	const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unknown.length) throw new HarnessError("CONFIG_INVALID", `${context} has unknown fields: ${unknown.join(", ")}`);
}

function digest(value: unknown): string {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export async function loadVerificationConfig(repositoryRoot: string): Promise<VerificationConfig | undefined> {
	const path = join(repositoryRoot, CONFIG_PATH);
	let source: string;
	try { source = await readFile(path, "utf8"); }
	catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: unknown;
	try { parsed = parse(source); }
	catch (error) { throw new HarnessError("CONFIG_INVALID", `Invalid ${CONFIG_PATH}: ${error instanceof Error ? error.message : String(error)}`); }
	const root = object(parsed, CONFIG_PATH);
	assertFields(root, ["schemaVersion", "defaultProfile", "profiles"], CONFIG_PATH);
	if (root.schemaVersion !== 1) throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} schemaVersion must be 1`);
	if (root.defaultProfile !== undefined && (typeof root.defaultProfile !== "string" || !NAME.test(root.defaultProfile))) throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} has an invalid defaultProfile`);
	const profileRecords = object(root.profiles, `${CONFIG_PATH} profiles`);
	if (!Object.keys(profileRecords).length) throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} must define at least one profile`);
	const profiles: Record<string, VerificationProfile> = {};
	for (const [name, value] of Object.entries(profileRecords)) {
		if (!NAME.test(name)) throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} has an invalid profile name: ${name}`);
		const profile = object(value, `${CONFIG_PATH} profile ${name}`);
		assertFields(profile, ["shell", "bootstrap", "requiredEnvironment"], `${CONFIG_PATH} profile ${name}`);
		if (typeof profile.shell !== "string" || !isAbsolute(profile.shell)) throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} profile ${name} requires an absolute shell path`);
		try { await access(profile.shell, constants.X_OK); }
		catch { throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} profile ${name} shell is not executable: ${profile.shell}`); }
		if (profile.bootstrap !== undefined && (typeof profile.bootstrap !== "string" || !profile.bootstrap.trim())) throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} profile ${name} has an invalid bootstrap`);
		if (profile.requiredEnvironment !== undefined && (!Array.isArray(profile.requiredEnvironment) || profile.requiredEnvironment.some((entry) => typeof entry !== "string" || !ENVIRONMENT_NAME.test(entry)))) throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} profile ${name} has invalid requiredEnvironment names`);
		const requiredEnvironment = [...new Set((profile.requiredEnvironment ?? []) as string[])];
		profiles[name] = { shell: profile.shell, ...(profile.bootstrap ? { bootstrap: profile.bootstrap.trim() } : {}), requiredEnvironment };
	}
	const defaultProfile = root.defaultProfile as string | undefined;
	if (defaultProfile && !profiles[defaultProfile]) throw new HarnessError("CONFIG_INVALID", `${CONFIG_PATH} defaultProfile does not exist: ${defaultProfile}`);
	return { schemaVersion: 1, path, ...(defaultProfile ? { defaultProfile } : {}), profiles };
}

export async function resolveVerificationProfile(repositoryRoot: string, check: NormalizedVerificationCheck): Promise<ResolvedVerificationProfile> {
	const config = await loadVerificationConfig(repositoryRoot);
	if (!config) {
		if (check.profile) throw new HarnessError("CONFIG_INVALID", `Verification check ${check.id} selects profile ${check.profile}, but ${CONFIG_PATH} does not exist`);
		const legacy = { shell: "/bin/sh", requiredEnvironment: [] as string[] };
		return { name: "legacy", ...legacy, digest: digest(legacy), legacy: true };
	}
	const name = check.profile ?? config.defaultProfile;
	if (!name) throw new HarnessError("CONFIG_INVALID", `Verification check ${check.id} requires a profile because ${CONFIG_PATH} has no defaultProfile`);
	const profile = config.profiles[name];
	if (!profile) throw new HarnessError("CONFIG_INVALID", `Verification check ${check.id} selects unknown profile: ${name}`);
	return { name, ...profile, digest: digest({ name, ...profile }), legacy: false, configPath: config.path };
}
