import { relative } from "node:path";
import { HarnessError } from "./errors.js";
import { RepositoryMutex } from "./idempotency.js";
import { assertCleanRepository, runGit } from "./repository.js";

/** The sole owner of runtime-time mutations to the canonical Git directory. */
export type ManagedChildWorkspace = "repository" | "worktree";

/** Hold the common-dir lock only for children that can mutate the canonical checkout. */
export function runManagedChild<T>(coordinator: Pick<RepositoryMutex, "run">, workspace: ManagedChildWorkspace, owner: string, operation: () => Promise<T>): Promise<T> {
	return workspace === "repository" ? coordinator.run(owner, operation) : operation();
}

export class CanonicalMutationCoordinator {
	readonly mutex: RepositoryMutex;
	constructor(readonly repositoryRoot: string, lockRoot = repositoryRoot) {
		this.mutex = new RepositoryMutex(lockRoot);
	}
	async run<T>(owner: string, operation: () => Promise<T>): Promise<T> {
		return this.mutex.run(owner, operation);
	}
	async commitHarness(paths: string[], message: string): Promise<void> {
		const rel = paths.map((p) => relative(this.repositoryRoot, p).replaceAll("\\", "/"));
		if (rel.some((p) => !p || p.startsWith("../") || p === ".." || !p.startsWith("agent-artifacts/"))) {
			throw new HarnessError("CAPABILITY_DENIED", `Refusing hook bypass for non-harness paths: ${rel.join(", ")}`);
		}
		const before = (await runGit(this.repositoryRoot, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
		const unstagedRequested = rel.filter((path) => !before.includes(path));
		if (unstagedRequested.length) await runGit(this.repositoryRoot, ["add", "-A", "--", ...unstagedRequested]);
		const staged = (await runGit(this.repositoryRoot, ["diff", "--cached", "--name-only", "-z"])).split("\0").filter(Boolean);
		if (staged.some((p) => !rel.some((allowed) => p === allowed || p.startsWith(`${allowed}/`)))) {
			throw new HarnessError("CAPABILITY_DENIED", `Unrelated staged paths prevent harness hook bypass: ${staged.join(", ")}`);
		}
		await runGit(this.repositoryRoot, ["commit", "--no-verify", "-m", message]);
	}
	async assertClean(): Promise<void> { await assertCleanRepository(this.repositoryRoot); }
}
