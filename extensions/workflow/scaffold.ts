import { mkdir, readFile, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { DEFAULT_HARNESS_CONFIG, loadHarnessConfig } from "./config.js";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, atomicWriteFile, isGitPathIgnored, runGit } from "./repository.js";

export type HarnessScaffoldProfile = "standard" | "economy";

function economyConfig() {
	const roleNames = Object.keys(DEFAULT_HARNESS_CONFIG.roles);
	return {
		schemaVersion: 1,
		models: {
			sol: { provider: "openai-codex", model: "gpt-5.6-luna", capabilityRank: 100 },
			terra: { provider: "openai-codex", model: "gpt-5.6-luna", capabilityRank: 100 },
			luna: { provider: "openai-codex", model: "gpt-5.6-luna", capabilityRank: 100 },
		},
		roles: Object.fromEntries(
			roleNames.map((role) => [
				role,
				{
					models: [{ model: "luna", effort: role === "implementer" || role === "repair-implementer" ? "medium" : "low" }],
				},
			]),
		),
		limits: { maxConcurrency: 2, maxActiveSubagentsPerSession: 16, maxSubagentDepth: 1, protocolNudges: 1, repairRounds: 1 },
	};
}

function standardConfig() {
	return {
		schemaVersion: 1,
		orchestrator: { modelSwitching: "auto-visible" },
		limits: { maxConcurrency: 4, maxActiveSubagentsPerSession: 16, maxSubagentDepth: 1, protocolNudges: 1, repairRounds: 2 },
	};
}

export interface HarnessScaffoldResult {
	created: boolean;
	profile: HarnessScaffoldProfile;
	configPath: string;
	worktreeIgnoreAdded: boolean;
	commit?: string;
}

const WORKTREE_IGNORE_PATTERN = "/.worktree/";
const PRIVATE_STATE_IGNORE_PATTERN = "/.pibox/";
const WORKTREE_IGNORE_PROBE = ".worktree/pibox/.ignore-check";
const PRIVATE_STATE_IGNORE_PROBE = ".pibox/.ignore-check";

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function ensureHarnessIgnores(repositoryRoot: string, ignorePath: string): Promise<boolean> {
	const required: string[] = [];
	if (!(await isGitPathIgnored(repositoryRoot, WORKTREE_IGNORE_PROBE))) required.push(WORKTREE_IGNORE_PATTERN);
	if (!(await isGitPathIgnored(repositoryRoot, PRIVATE_STATE_IGNORE_PROBE))) required.push(PRIVATE_STATE_IGNORE_PATTERN);
	if (required.length === 0) return false;
	const previous = await readOptional(ignorePath);
	const prefix = previous && !previous.endsWith("\n") ? `${previous}\n` : (previous ?? "");
	await atomicWriteFile(ignorePath, `${prefix}${required.join("\n")}\n`);
	for (const probe of [WORKTREE_IGNORE_PROBE, PRIVATE_STATE_IGNORE_PROBE]) {
		if (!(await isGitPathIgnored(repositoryRoot, probe))) throw new HarnessError("CONFIG_INVALID", "Failed to establish PiBox runtime ignores in .gitignore");
	}
	return true;
}

export async function scaffoldHarness(repositoryRoot: string, profile: HarnessScaffoldProfile, overwrite = false): Promise<HarnessScaffoldResult> {
	await assertCleanRepository(repositoryRoot);
	const configPath = join(repositoryRoot, ".pi", "harness.yaml");
	const ignorePath = join(repositoryRoot, ".gitignore");
	const previousConfig = await readOptional(configPath);
	const previousIgnore = await readOptional(ignorePath);
	let ignoreAdded = false;
	try {
		ignoreAdded = await ensureHarnessIgnores(repositoryRoot, ignorePath);
		if (previousConfig !== undefined && !overwrite) {
			loadHarnessConfig(repositoryRoot);
			if (ignoreAdded) {
				await runGit(repositoryRoot, ["add", "--", ".gitignore"]);
				await runGit(repositoryRoot, ["commit", "-m", "chore(harness): ignore repository-local worktrees", "--", ".gitignore"]);
			}
			return {
				created: false,
				profile,
				configPath,
				worktreeIgnoreAdded: ignoreAdded,
				...(ignoreAdded ? { commit: await runGit(repositoryRoot, ["rev-parse", "HEAD"]) } : {}),
			};
		}

		await mkdir(join(repositoryRoot, ".pi"), { recursive: true });
		const content = [
			"# PiBox harness repository policy.",
			`# Scaffold profile: ${profile}. Arrays replace inherited defaults.`,
			stringify(profile === "economy" ? economyConfig() : standardConfig()).trim(),
			"",
		].join("\n");
		await atomicWriteFile(configPath, content);
		loadHarnessConfig(repositoryRoot);
		const paths = [relative(repositoryRoot, configPath), ...(ignoreAdded ? [".gitignore"] : [])];
		await runGit(repositoryRoot, ["add", "--", ...paths]);
		await runGit(repositoryRoot, ["commit", "-m", `chore(harness): initialize ${profile} policy`, "--", ...paths]);
		return { created: true, profile, configPath, worktreeIgnoreAdded: ignoreAdded, commit: await runGit(repositoryRoot, ["rev-parse", "HEAD"]) };
	} catch (error) {
		await runGit(repositoryRoot, ["reset", "--quiet", "HEAD", "--", relative(repositoryRoot, configPath), ".gitignore"]).catch(() => undefined);
		if (previousConfig === undefined) await rm(configPath, { force: true });
		else await atomicWriteFile(configPath, previousConfig);
		if (previousIgnore === undefined) await rm(ignorePath, { force: true });
		else await atomicWriteFile(ignorePath, previousIgnore);
		throw error instanceof HarnessError ? error : new HarnessError("CONFIG_INVALID", error instanceof Error ? error.message : String(error));
	}
}
