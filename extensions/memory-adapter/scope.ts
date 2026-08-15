import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface RepositoryScope {
	repoId: string;
	root: string;
	commit?: string;
}

export async function deriveRepositoryScope(pi: ExtensionAPI, cwd: string): Promise<RepositoryScope> {
	const [rootResult, commonResult, commitResult] = await Promise.all([
		pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 3_000 }),
		pi.exec("git", ["rev-parse", "--git-common-dir"], { cwd, timeout: 3_000 }),
		pi.exec("git", ["rev-parse", "HEAD"], { cwd, timeout: 3_000 }),
	]);
	const root = rootResult.code === 0 ? rootResult.stdout.trim() : realpathSync(cwd);
	const rawCommon = commonResult.code === 0 ? commonResult.stdout.trim() : root;
	const common = isAbsolute(rawCommon) ? rawCommon : resolve(cwd, rawCommon);
	const canonical = existsSync(common) ? realpathSync(common) : resolve(common);
	const repoId = createHash("sha256").update(canonical).digest("hex").slice(0, 24);
	return {
		repoId,
		root,
		...(commitResult.code === 0 ? { commit: commitResult.stdout.trim() } : {}),
	};
}
