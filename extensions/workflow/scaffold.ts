import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join, relative } from "node:path";
import { stringify } from "yaml";
import { DEFAULT_HARNESS_CONFIG, loadHarnessConfig } from "./config.js";
import { HarnessError } from "./errors.js";
import { atomicWriteFile, isGitPathIgnored, runGit } from "./repository.js";

export type HarnessScaffoldProfile = "standard" | "economy";

function repositoryPolicy(profile: HarnessScaffoldProfile) {
	const config = structuredClone(DEFAULT_HARNESS_CONFIG);
	if (profile === "economy") config.limits = { ...config.limits, maxConcurrency: 2 };
	for (const agent of Object.values(config.agents)) delete agent.tools;
	const { modelTierProfile: _effectiveSessionProfile, ...policy } = config;
	return policy;
}

export interface HarnessScaffoldResult {
	created: boolean;
	profile: HarnessScaffoldProfile;
	configPath: string;
	worktreeIgnoreAdded: boolean;
	gitInitialized?: boolean;
	developCreated?: boolean;
	branch?: string;
	commit?: string;
}

const PRIVATE_RUNTIME_IGNORE_PATTERN = "/.pibox/";
const PRIVATE_RUNTIME_IGNORE_PROBE = ".pibox/.ignore-check";
const LEGACY_PRIVATE_IGNORE_EXCEPTIONS = new Set(["!/.pibox/", "/.pibox/*", "!/.pibox/verification.yaml"]);
const WORKTREE_IGNORE_PATTERN = "/.worktree/";
const STORY_RUNTIME_IGNORES = [
	["/agent-artifacts/*/state.yaml", "agent-artifacts/ignore-probe/state.yaml"],
	["/agent-artifacts/*/ledger.yaml", "agent-artifacts/ignore-probe/ledger.yaml"],
	["/agent-artifacts/*/events.jsonl", "agent-artifacts/ignore-probe/events.jsonl"],
] as const;
const WORKTREE_IGNORE_PROBE = ".worktree/pibox/.ignore-check";

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function ensureHarnessIgnores(repositoryRoot: string, ignorePath: string): Promise<boolean> {
	const previous = await readOptional(ignorePath) ?? "";
	// Old workflow verification policy briefly made one .pibox file trackable. The
	// target keeps no workflow authority there, while other PiBox facilities still
	// require the whole private root to remain ignored.
	const retained = previous.split("\n").filter((line) => !LEGACY_PRIVATE_IGNORE_EXCEPTIONS.has(line));
	let normalized = retained.join("\n");
	if (previous.endsWith("\n") && !normalized.endsWith("\n")) normalized += "\n";
	const required: string[] = [];
	if (!(await isGitPathIgnored(repositoryRoot, PRIVATE_RUNTIME_IGNORE_PROBE)) || !normalized.split("\n").includes(PRIVATE_RUNTIME_IGNORE_PATTERN)) required.push(PRIVATE_RUNTIME_IGNORE_PATTERN);
	if (!(await isGitPathIgnored(repositoryRoot, WORKTREE_IGNORE_PROBE))) required.push(WORKTREE_IGNORE_PATTERN);
	for (const [pattern, probe] of STORY_RUNTIME_IGNORES) {
		if (!(await isGitPathIgnored(repositoryRoot, probe))) required.push(pattern);
	}
	if (required.length === 0 && normalized === previous) return false;
	const prefix = normalized && !normalized.endsWith("\n") ? `${normalized}\n` : normalized;
	await atomicWriteFile(ignorePath, `${prefix}${required.join("\n")}${required.length ? "\n" : ""}`);
	for (const probe of [PRIVATE_RUNTIME_IGNORE_PROBE, WORKTREE_IGNORE_PROBE, ...STORY_RUNTIME_IGNORES.map(([, probe]) => probe)]) {
		if (!(await isGitPathIgnored(repositoryRoot, probe))) throw new HarnessError("CONFIG_INVALID", "Failed to establish PiBox runtime ignores in .gitignore");
	}
	return true;
}

async function assertInitializationClean(repositoryRoot: string): Promise<void> {
	const status = await runGit(repositoryRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
	const unrelated = status.split("\n").filter(Boolean).filter((line) => !line.startsWith("?? .pibox/"));
	if (unrelated.length > 0) throw new HarnessError("DIRTY_CANONICAL_BRANCH", "Repository has uncommitted work unrelated to PiBox initialization", { status: unrelated.join("\n") });
}

async function gitRefExists(repositoryRoot: string, ref: string): Promise<boolean> {
	try {
		await runGit(repositoryRoot, ["show-ref", "--verify", "--quiet", ref]);
		return true;
	} catch {
		return false;
	}
}

async function gitHeadExists(repositoryRoot: string): Promise<boolean> {
	try {
		await runGit(repositoryRoot, ["rev-parse", "--verify", "HEAD"]);
		return true;
	} catch {
		return false;
	}
}

async function gitRepositoryRoot(cwd: string): Promise<string | undefined> {
	try {
		return await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		return undefined;
	}
}

/** Prepare the repository boundary before runtime state is created. Existing project files are never staged implicitly. */
export async function initializeHarnessRepository(cwd: string, profile: HarnessScaffoldProfile, overwrite = false): Promise<HarnessScaffoldResult> {
	let repositoryRoot = await gitRepositoryRoot(cwd);
	let gitInitialized = false;
	if (!repositoryRoot) {
		const entries = await readdir(cwd);
		if (entries.length > 0) {
			throw new HarnessError("DIRTY_CANONICAL_BRANCH", "Refusing to initialize Git around existing files. Establish and commit the project baseline first, then run harness init again.", { entries });
		}
		await runGit(cwd, ["init", "--quiet"]);
		gitInitialized = true;
		repositoryRoot = cwd;
	}

	try {
		await assertInitializationClean(repositoryRoot);
		const hasHead = await gitHeadExists(repositoryRoot);
		const hasDevelop = await gitRefExists(repositoryRoot, "refs/heads/develop");
		let developCreated = false;
		if (!hasHead) {
			await runGit(repositoryRoot, ["symbolic-ref", "HEAD", "refs/heads/develop"]);
			developCreated = true;
		} else {
			const currentBranch = await runGit(repositoryRoot, ["branch", "--show-current"]);
			if (currentBranch !== "develop") {
				if (hasDevelop) await runGit(repositoryRoot, ["switch", "develop"]);
				else if (await gitRefExists(repositoryRoot, "refs/remotes/origin/develop")) await runGit(repositoryRoot, ["switch", "--track", "-c", "develop", "origin/develop"]);
				else await runGit(repositoryRoot, ["switch", "-c", "develop"]);
				developCreated = !hasDevelop;
			}
		}
		const scaffold = await scaffoldHarness(repositoryRoot, profile, overwrite);
		return { ...scaffold, gitInitialized, developCreated, branch: "develop" };
	} catch (error) {
		if (gitInitialized) await rm(join(repositoryRoot, ".git"), { recursive: true, force: true });
		throw error;
	}
}

export async function scaffoldHarness(repositoryRoot: string, profile: HarnessScaffoldProfile, overwrite = false): Promise<HarnessScaffoldResult> {
	await assertInitializationClean(repositoryRoot);
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
			stringify(repositoryPolicy(profile)).trim(),
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
