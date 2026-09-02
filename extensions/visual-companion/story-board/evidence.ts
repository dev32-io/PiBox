import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { parseStoryRuntimeState } from "../../workflow/story-runtime-store.js";
import type { StoryRuntimeState } from "../../workflow/story-runtime-store.js";
import type { Diagnostic, EvidenceMetadata } from "./models.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_CURRENT_STATE_BYTES = 2 * 1024 * 1024;
const SUPPORTED = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".txt", ".md", ".json", ".yaml", ".yml", ".log"]);
const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json", ".yaml": "application/yaml", ".yml": "application/yaml", ".log": "text/plain" };

function safeRelative(path: string): boolean {
	return Boolean(path) && !isAbsolute(path) && !path.includes("\\") && path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}
function inside(root: string, candidate: string): boolean {
	const rel = relative(root, candidate);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function diagnostic(path: string, message: string): Diagnostic { return { path, message }; }
async function regularMember(root: string, path: string) {
	let current = root; const parts = path.split("/");
	for (const [index, part] of parts.entries()) {
		current = join(current, part); const info = await lstat(current).catch(() => undefined);
		if (!info) return { invalid: false };
		if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) return { invalid: true };
		if (index === parts.length - 1) { const real = await realpath(current).catch(() => undefined); return real ? { info, real, invalid: false } : { invalid: true }; }
	}
	return { invalid: true };
}

type ManifestEntry = Record<string, unknown>;

export async function readEvidenceMetadata(repositoryRoot: string, storyId: string, evaluationId: string): Promise<EvidenceMetadata[]> {
	if (!ID.test(storyId) || !ID.test(evaluationId)) return [];
	const repository = resolve(repositoryRoot);
	const lexicalStoryRoot = join(repository, "agent-artifacts", storyId);
	const evaluationsRoot = join(lexicalStoryRoot, "evaluations"); const evaluationRoot = join(evaluationsRoot, evaluationId); const evaluationManifest = join(evaluationRoot, "evaluation.yaml");
	const evidenceParent = join(lexicalStoryRoot, "evidence"); const evidenceRoot = join(evidenceParent, evaluationId);
	const displayRoot = `agent-artifacts/${storyId}/evidence/${evaluationId}`;
	const manifestPath = join(evidenceRoot, "manifest.yaml");
	let value: unknown;
	const [repositoryReal, storyReal, evaluationsReal, evaluationReal, evaluationManifestReal, evidenceParentReal, rootReal, storyInfo, evaluationsInfo, evaluationInfo, evaluationManifestInfo, evidenceParentInfo, rootInfo] = await Promise.all([
		realpath(repository).catch(() => undefined), realpath(lexicalStoryRoot).catch(() => undefined), realpath(evaluationsRoot).catch(() => undefined), realpath(evaluationRoot).catch(() => undefined), realpath(evaluationManifest).catch(() => undefined), realpath(evidenceParent).catch(() => undefined), realpath(evidenceRoot).catch(() => undefined),
		lstat(lexicalStoryRoot).catch(() => undefined), lstat(evaluationsRoot).catch(() => undefined), lstat(evaluationRoot).catch(() => undefined), lstat(evaluationManifest).catch(() => undefined), lstat(evidenceParent).catch(() => undefined), lstat(evidenceRoot).catch(() => undefined),
	]);
	const evaluationContained = Boolean(repositoryReal && storyReal && evaluationsReal && evaluationReal && evaluationManifestReal && storyInfo?.isDirectory() && !storyInfo.isSymbolicLink() && evaluationsInfo?.isDirectory() && !evaluationsInfo.isSymbolicLink() && evaluationInfo?.isDirectory() && !evaluationInfo.isSymbolicLink() && evaluationManifestInfo?.isFile() && !evaluationManifestInfo.isSymbolicLink() && inside(repositoryReal, storyReal) && inside(storyReal, evaluationsReal) && inside(evaluationsReal, evaluationReal) && inside(evaluationReal, evaluationManifestReal));
	const rootContained = Boolean(evaluationContained && evidenceParentReal && rootReal && evidenceParentInfo?.isDirectory() && !evidenceParentInfo.isSymbolicLink() && rootInfo?.isDirectory() && !rootInfo.isSymbolicLink() && inside(storyReal!, evidenceParentReal) && inside(evidenceParentReal, rootReal));
	if (!rootContained) return rootInfo ? [{ id: "manifest", manifestMember: false, available: false, supported: false, diagnostics: [diagnostic(`${displayRoot}/manifest.yaml`, "Evidence root is not a contained canonical directory")] }] : [];
	const manifestInfo = await lstat(manifestPath).catch(() => undefined);
	const manifestReal = await realpath(manifestPath).catch(() => undefined);
	if (!manifestInfo) return [];
	if (manifestInfo.isSymbolicLink() || !manifestInfo.isFile() || !manifestReal || !rootReal || !inside(rootReal, manifestReal)) return [{ id: "manifest", manifestMember: false, available: false, supported: false, diagnostics: [diagnostic(`${displayRoot}/manifest.yaml`, "Evidence manifest is not a regular canonical file")] }];
	try { value = parse(await readFile(manifestPath, "utf8")); }
	catch { return [{ id: "manifest", manifestMember: false, available: false, supported: false, diagnostics: [diagnostic(`${displayRoot}/manifest.yaml`, "Evidence manifest is malformed")] }]; }
	const record = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
	if (record.schemaVersion !== 1 || record.evaluation !== evaluationId || !Array.isArray(record.entries)) return [{ id: "manifest", manifestMember: false, available: false, supported: false, diagnostics: [diagnostic(`${displayRoot}/manifest.yaml`, "Evidence manifest has an invalid contract")] }];
	return Promise.all((record.entries as unknown[]).map(async (raw, index) => {
		const entry = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as ManifestEntry : {};
		const id = typeof entry.id === "string" ? entry.id : `EV-${String(index + 1).padStart(3, "0")}`;
		const path = typeof entry.path === "string" ? entry.path : undefined;
		const diagnostics: Diagnostic[] = [];
		let available = false;
		let member = true;
		let extension = "";
		if (path) {
			extension = extname(path).toLowerCase();
			if (!safeRelative(path) || !rootContained) { member = false; diagnostics.push(diagnostic(`${displayRoot}/manifest.yaml`, "Evidence member has an unsafe path")); }
			else {
				const { info, real: candidateReal, invalid } = await regularMember(evidenceRoot, path);
				if (invalid) { member = false; diagnostics.push(diagnostic(`${displayRoot}/${path}`, "Evidence member is not a contained regular file")); }
				else if (!info || !candidateReal) diagnostics.push(diagnostic(`${displayRoot}/${path}`, "Evidence member is missing"));
				else if (!info.isFile() || !rootReal || !inside(rootReal, candidateReal)) { member = false; diagnostics.push(diagnostic(`${displayRoot}/${path}`, "Evidence member is not a contained regular file")); }
				else available = true;
			}
		}
		const supported = !path || SUPPORTED.has(extension);
		if (path && !supported) diagnostics.push(diagnostic(`${displayRoot}/${path}`, "Evidence media type is unsupported"));
		return {
			id,
			...(path ? { path: `${displayRoot}/${path}` } : {}),
			...(typeof entry.result === "string" ? { result: entry.result } : {}),
			...(typeof entry.description === "string" ? { description: entry.description } : {}),
			...(typeof entry.command === "string" ? { command: entry.command } : {}),
			...(typeof entry.checksum === "string" ? { checksum: entry.checksum } : {}),
			...(path && MIME[extension] ? { mediaType: MIME[extension] } : {}),
			manifestMember: member, available: path ? available : true, supported, diagnostics,
		};
	}));
}

/** Re-validates that a requested path is a current regular manifest member, without reading its bytes. */
export async function resolveEvidenceMember(repositoryRoot: string, storyId: string, evaluationId: string, memberPath: string): Promise<string | undefined> {
	if (!safeRelative(memberPath)) return undefined;
	const metadata = await readEvidenceMetadata(repositoryRoot, storyId, evaluationId);
	const projected = `agent-artifacts/${storyId}/evidence/${evaluationId}/${memberPath}`;
	const member = metadata.find((entry) => entry.path === projected);
	if (!member?.manifestMember || !member.available) return undefined;
	return join(resolve(repositoryRoot), projected);
}

/** Projects only the exact story-relative evidence references cited by current state.e2e. */
export async function readCurrentEvidenceMetadata(repositoryRoot: string, storyId: string, evidenceRefs: readonly string[]): Promise<EvidenceMetadata[]> {
	if (!ID.test(storyId)) return [];
	const repository = resolve(repositoryRoot); const storyRoot = join(repository, "agent-artifacts", storyId); const displayRoot = `agent-artifacts/${storyId}`;
	const [repositoryReal, storyReal] = await Promise.all([realpath(repository).catch(() => undefined), realpath(storyRoot).catch(() => undefined)]);
	if (!repositoryReal || !storyReal || !inside(repositoryReal, storyReal)) return [];
	return Promise.all(evidenceRefs.map(async (reference, index): Promise<EvidenceMetadata> => {
		const id = `E2E-EV-${String(index + 1).padStart(3, "0")}`; const diagnostics: Diagnostic[] = [];
		const safe = safeRelative(reference) && (reference === "evidence" || reference.startsWith("evidence/")); const extension = extname(reference).toLowerCase(); const supported = safe && SUPPORTED.has(extension);
		let available = false; let member = safe;
		if (!safe) diagnostics.push(diagnostic(`${displayRoot}/state.yaml`, "Cited evidence has an unsafe path"));
		else {
			const { info, real, invalid } = await regularMember(storyRoot, reference);
			if (invalid || (info && (!info.isFile() || !real || !inside(storyReal, real)))) { member = false; diagnostics.push(diagnostic(`${displayRoot}/${reference}`, "Cited evidence is not a contained regular file")); }
			else if (!info || !real) diagnostics.push(diagnostic(`${displayRoot}/${reference}`, "Cited evidence is missing"));
			else available = true;
		}
		if (safe && !supported) diagnostics.push(diagnostic(`${displayRoot}/${reference}`, "Cited evidence media type is unsupported"));
		return { id, ...(safe ? { path: `${displayRoot}/${reference}`, memberPath: reference } : {}), description: safe ? reference : "Invalid cited evidence", ...(MIME[extension] ? { mediaType: MIME[extension] } : {}), manifestMember: member, available, supported, diagnostics };
	}));
}

/** Reads authoritative current state through one contained, no-follow, byte-bounded descriptor. */
export async function readBoundedCurrentRuntimeState(repositoryRoot: string, storyId: string, storyRoot = join(resolve(repositoryRoot), "agent-artifacts", storyId)): Promise<{ bytes: Buffer; state: StoryRuntimeState }> {
	if (!ID.test(storyId)) throw new Error("invalid story id");
	const repository = resolve(repositoryRoot); const storyInfo = await lstat(storyRoot).catch(() => undefined);
	const [repositoryReal, storyReal] = await Promise.all([realpath(repository).catch(() => undefined), realpath(storyRoot).catch(() => undefined)]);
	if (!storyInfo?.isDirectory() || storyInfo.isSymbolicLink() || !repositoryReal || !storyReal || !inside(repositoryReal, storyReal)) throw new Error("story is not contained");
	const stateMember = await regularMember(storyRoot, "state.yaml");
	if (stateMember.invalid || !stateMember.info?.isFile() || !stateMember.real || !inside(storyReal, stateMember.real)) throw new Error("state is not contained");
	const handle = await open(join(storyRoot, "state.yaml"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat(); if (!info.isFile() || info.size > MAX_CURRENT_STATE_BYTES) throw new Error("state exceeds the supported size");
		const bytes = await handle.readFile(); if (bytes.byteLength > MAX_CURRENT_STATE_BYTES) throw new Error("state exceeds the supported size");
		return { bytes, state: parseStoryRuntimeState(parse(bytes.toString("utf8")), storyId) };
	} finally { await handle.close(); }
}

/** Re-validates current state authority and the cited member without following symlinks in any path component. */
export async function resolveCurrentEvidenceMember(repositoryRoot: string, storyId: string, memberPath: string): Promise<string | undefined> {
	if (!ID.test(storyId) || !safeRelative(memberPath) || !memberPath.startsWith("evidence/")) return undefined;
	const repository = resolve(repositoryRoot); const storyRoot = join(repository, "agent-artifacts", storyId); const storyInfo = await lstat(storyRoot).catch(() => undefined);
	const [repositoryReal, storyReal] = await Promise.all([realpath(repository).catch(() => undefined), realpath(storyRoot).catch(() => undefined)]); if (!storyInfo?.isDirectory() || storyInfo.isSymbolicLink() || !repositoryReal || !storyReal || !inside(repositoryReal, storyReal)) return undefined;
	let evidenceRefs: readonly string[]; try { evidenceRefs = (await readBoundedCurrentRuntimeState(repositoryRoot, storyId, storyRoot)).state.e2e.evidenceRefs; } catch { return undefined; }
	if (!evidenceRefs.includes(memberPath)) return undefined;
	const { info, real, invalid } = await regularMember(storyRoot, memberPath); if (invalid || !info?.isFile() || !real || !inside(storyReal, real)) return undefined;
	return join(storyRoot, memberPath);
}
