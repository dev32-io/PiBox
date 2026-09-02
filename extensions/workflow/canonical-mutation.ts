import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { HarnessError } from "./errors.js";
import { assertCleanRepository, runGit } from "./repository.js";

const MUTEXES = new Map<string, Promise<void>>();
interface ActiveLease { active: boolean; }
const ACTIVE_LEASES = new AsyncLocalStorage<ReadonlyMap<string, ActiveLease>>();

function canonicalKey(key: string): string {
	const absolute = resolve(key);
	try { return realpathSync(absolute); } catch { return absolute; }
}

function abortError(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	const error = new Error("The operation was aborted");
	error.name = "AbortError";
	return error;
}

async function waitForTurn(prior: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (!signal) { await prior; return; }
	if (signal.aborted) throw abortError(signal);
	let onAbort!: () => void;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		await Promise.race([prior, aborted]);
		if (signal.aborted) throw abortError(signal);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

/** In-process canonical Git serializer. It stores no workflow files. */
export class RepositoryMutex {
	readonly key: string;
	constructor(key: string) { this.key = canonicalKey(key); }
	async run<T>(_owner: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const inherited = ACTIVE_LEASES.getStore();
		const inheritedLease = inherited?.get(this.key);
		if (inheritedLease?.active) {
			if (signal?.aborted) throw abortError(signal);
			return operation();
		}

		if (signal?.aborted) throw abortError(signal);
		const prior = MUTEXES.get(this.key) ?? Promise.resolve();
		let release!: () => void;
		const gate = new Promise<void>((resolveGate) => { release = resolveGate; });
		const tail = prior.then(() => gate);
		MUTEXES.set(this.key, tail);
		void tail.then(() => { if (MUTEXES.get(this.key) === tail) MUTEXES.delete(this.key); });
		try {
			await waitForTurn(prior, signal);
			const lease: ActiveLease = { active: true };
			const scope = new Map(inherited ?? []);
			scope.set(this.key, lease);
			try { return await ACTIVE_LEASES.run(scope, operation); }
			finally { lease.active = false; }
		} finally {
			release();
		}
	}
}

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
	async run<T>(owner: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		return this.mutex.run(owner, operation, signal);
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
