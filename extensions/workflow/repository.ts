import { createHash, randomUUID } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { HarnessError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface RepositoryIdentity {
	id: string;
	root: string;
	privateRoot: string;
	commonDir?: string;
}

export async function runGit(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
		return result.stdout.trim();
	} catch (error) {
		const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
		throw new HarnessError("GIT_OPERATION_FAILED", stderr || `git ${args.join(" ")} failed`, { args });
	}
}

export async function isGitPathIgnored(repositoryRoot: string, repositoryRelativePath: string): Promise<boolean> {
	try {
		await execFileAsync("git", ["check-ignore", "--quiet", "--no-index", "--", repositoryRelativePath], { cwd: repositoryRoot, encoding: "utf8" });
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
		const stderr = typeof error === "object" && error !== null && "stderr" in error ? String(error.stderr).trim() : "";
		throw new HarnessError("GIT_OPERATION_FAILED", stderr || `Unable to inspect Git ignore policy for ${repositoryRelativePath}`);
	}
}

export function discoverCommonDirSync(cwd: string): string | undefined {
	try {
		const value = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8" }).trim();
		return realpathSync(isAbsolute(value) ? value : resolve(cwd, value));
	} catch { return undefined; }
}

export async function discoverRepository(cwd: string, home = homedir()): Promise<RepositoryIdentity> {
	let root: string;
	try {
		root = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
	} catch {
		throw new HarnessError("NOT_A_GIT_REPOSITORY", `${cwd} is not inside a Git repository`);
	}
	const discoveredRoot = await realpath(root);
	const commonDirValue = await runGit(discoveredRoot, ["rev-parse", "--git-common-dir"]);
	const commonDir = await realpath(isAbsolute(commonDirValue) ? commonDirValue : resolve(discoveredRoot, commonDirValue));
	const canonicalRoot = basename(commonDir) === ".git" ? dirname(commonDir) : discoveredRoot;
	const id = createHash("sha256").update(commonDir).digest("hex").slice(0, 20);
	// Operational records belong to the repository, but remain intentionally untracked.
	// Resolving from the common Git directory keeps every linked worktree on one shared state root.
	return { id, root: canonicalRoot, privateRoot: join(canonicalRoot, ".pibox"), commonDir };
}

export async function assertCleanRepository(root: string): Promise<void> {
	const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status) throw new HarnessError("DIRTY_CANONICAL_BRANCH", "Canonical working branch has uncommitted changes", { status });
}

export async function atomicWriteFile(path: string, content: string, mode?: number): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
	try {
		await writeFile(temporary, content, { encoding: "utf8", ...(mode === undefined ? {} : { mode }) });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

export async function readTextIfExists(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
		throw error;
	}
}
