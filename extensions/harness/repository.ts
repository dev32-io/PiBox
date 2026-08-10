import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { HarnessError } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface RepositoryIdentity {
	id: string;
	root: string;
	privateRoot: string;
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
	return { id, root: canonicalRoot, privateRoot: join(home, ".pi", "agent", "harness", "repositories", id) };
}

export async function assertCleanRepository(root: string): Promise<void> {
	const status = await runGit(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
	if (status) throw new HarnessError("DIRTY_CANONICAL_BRANCH", "Canonical feature branch has uncommitted changes", { status });
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
