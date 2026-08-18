import { createHash } from "node:crypto";
import { HarnessError } from "./errors.js";
import type { VerificationCheck, VerificationCheckSpec } from "./types.js";

const ID = /^[a-z0-9][a-z0-9-]*$/;

export interface NormalizedVerificationCheck {
	id: string;
	command: string;
	profile?: string;
}

export function verificationCommand(check: VerificationCheckSpec): string {
	return typeof check === "string" ? check : check.command;
}

export function verificationProfile(check: VerificationCheckSpec): string | undefined {
	return typeof check === "string" ? undefined : check.profile;
}

export function renderVerificationCheck(check: VerificationCheckSpec): string {
	const command = verificationCommand(check);
	const profile = verificationProfile(check);
	return profile ? `[${profile}] ${command}` : command;
}

export function normalizeVerificationChecks(value: unknown, source = "stage checks"): VerificationCheckSpec[] {
	if (value === undefined) return [];
	if (!Array.isArray(value)) throw new HarnessError("INVALID_ARTIFACT", `${source} must be an array`);
	const checks: VerificationCheckSpec[] = value.map((entry, index) => {
		if (typeof entry === "string") {
			if (!entry.trim()) throw new HarnessError("INVALID_ARTIFACT", `${source} contains an empty command`);
			return entry.trim();
		}
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new HarnessError("INVALID_ARTIFACT", `${source} contains an invalid check`);
		const record = entry as Record<string, unknown>;
		const unknown = Object.keys(record).filter((key) => !["id", "command", "profile"].includes(key));
		if (unknown.length) throw new HarnessError("INVALID_ARTIFACT", `${source} check ${index + 1} has unknown fields: ${unknown.join(", ")}`);
		if (typeof record.command !== "string" || !record.command.trim()) throw new HarnessError("INVALID_ARTIFACT", `${source} check ${index + 1} requires a command`);
		if (record.id !== undefined && (typeof record.id !== "string" || !ID.test(record.id))) throw new HarnessError("INVALID_ARTIFACT", `${source} check ${index + 1} has an invalid id`);
		if (record.profile !== undefined && (typeof record.profile !== "string" || !ID.test(record.profile))) throw new HarnessError("INVALID_ARTIFACT", `${source} check ${index + 1} has an invalid profile`);
		return {
			...(record.id === undefined ? {} : { id: record.id as string }),
			command: record.command.trim(),
			...(record.profile === undefined ? {} : { profile: record.profile as string }),
		} satisfies VerificationCheck;
	});
	normalizeChecks(checks, source);
	return checks;
}

export function normalizeChecks(checks: VerificationCheckSpec[], source = "stage checks"): NormalizedVerificationCheck[] {
	const ids = new Set<string>();
	return checks.map((check, index) => {
		const command = verificationCommand(check).trim();
		if (!command) throw new HarnessError("INVALID_ARTIFACT", `${source} contains an empty command`);
		const explicitId = typeof check === "string" ? undefined : check.id;
		const id = explicitId ?? `check-${index + 1}`;
		if (!ID.test(id) || ids.has(id)) throw new HarnessError("INVALID_ARTIFACT", `${source} contains an invalid or duplicate check id: ${id}`);
		ids.add(id);
		const profile = verificationProfile(check);
		if (profile !== undefined && !ID.test(profile)) throw new HarnessError("INVALID_ARTIFACT", `${source} contains an invalid profile: ${profile}`);
		return { id, command, ...(profile ? { profile } : {}) };
	});
}

export function verificationCheckDigest(check: NormalizedVerificationCheck): string {
	return createHash("sha256").update(JSON.stringify(check)).digest("hex");
}
