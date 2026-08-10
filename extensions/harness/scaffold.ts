import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { DEFAULT_HARNESS_CONFIG, loadHarnessConfig } from "./config.js";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, atomicWriteFile, runGit } from "./repository.js";

export type HarnessScaffoldProfile = "standard" | "economy";

function economyConfig() {
	const roleNames = Object.keys(DEFAULT_HARNESS_CONFIG.roles);
	return {
		schemaVersion: 1,
		roles: Object.fromEntries(
			roleNames.map((role) => [
				role,
				{
					models: [{ model: "luna", effort: role === "implementer" || role === "repair-implementer" ? "medium" : "low" }],
				},
			]),
		),
		limits: { maxConcurrency: 2, protocolNudges: 1, repairRounds: 1 },
	};
}

function standardConfig() {
	return {
		schemaVersion: 1,
		orchestrator: { modelSwitching: "auto-visible" },
		limits: { maxConcurrency: 4, protocolNudges: 1, repairRounds: 2 },
	};
}

export interface HarnessScaffoldResult {
	created: boolean;
	profile: HarnessScaffoldProfile;
	configPath: string;
	commit?: string;
}

export async function scaffoldHarness(repositoryRoot: string, profile: HarnessScaffoldProfile, overwrite = false): Promise<HarnessScaffoldResult> {
	await assertCleanRepository(repositoryRoot);
	const configPath = join(repositoryRoot, ".pi", "harness.yaml");
	let previous: string | undefined;
	try {
		previous = await readFile(configPath, "utf8");
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
	}
	if (previous !== undefined && !overwrite) {
		loadHarnessConfig(repositoryRoot);
		return { created: false, profile, configPath };
	}
	await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
	const content = [
		"# PiBox harness repository policy.",
		`# Scaffold profile: ${profile}. Arrays replace inherited defaults.`,
		stringify(profile === "economy" ? economyConfig() : standardConfig()).trim(),
		"",
	].join("\n");
	try {
		await atomicWriteFile(configPath, content);
		loadHarnessConfig(repositoryRoot);
		await runGit(repositoryRoot, ["add", "--", relative(repositoryRoot, configPath)]);
		await runGit(repositoryRoot, ["commit", "-m", `chore(harness): initialize ${profile} policy`, "--", relative(repositoryRoot, configPath)]);
		return { created: true, profile, configPath, commit: await runGit(repositoryRoot, ["rev-parse", "HEAD"]) };
	} catch (error) {
		try {
			await runGit(repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(repositoryRoot, configPath)]);
		} catch {
			if (previous === undefined) await runGit(repositoryRoot, ["rm", "--cached", "--ignore-unmatch", "--", relative(repositoryRoot, configPath)]).catch(() => undefined);
		}
		if (previous === undefined) await rm(configPath, { force: true });
		else await atomicWriteFile(configPath, previous);
		throw error instanceof HarnessError ? error : new HarnessError("CONFIG_INVALID", error instanceof Error ? error.message : String(error));
	}
}
