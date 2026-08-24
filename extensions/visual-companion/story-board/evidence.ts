import { lstat, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import type { Diagnostic, EvidenceMetadata } from "./models.js";

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

type ManifestEntry = Record<string, unknown>;

export async function readEvidenceMetadata(repositoryRoot: string, storyId: string, evaluationId: string): Promise<EvidenceMetadata[]> {
	if (!ID.test(storyId) || !ID.test(evaluationId)) return [];
	const repository = resolve(repositoryRoot);
	const lexicalStoryRoot = join(repository, "agent-artifacts", storyId);
	const evidenceRoot = join(lexicalStoryRoot, "evidence", evaluationId);
	const displayRoot = `agent-artifacts/${storyId}/evidence/${evaluationId}`;
	const manifestPath = join(evidenceRoot, "manifest.yaml");
	let value: unknown;
	const [repositoryReal, storyReal, rootReal, storyInfo, rootInfo] = await Promise.all([
		realpath(repository).catch(() => undefined), realpath(lexicalStoryRoot).catch(() => undefined), realpath(evidenceRoot).catch(() => undefined),
		lstat(lexicalStoryRoot).catch(() => undefined), lstat(evidenceRoot).catch(() => undefined),
	]);
	const rootContained = Boolean(repositoryReal && storyReal && rootReal && storyInfo?.isDirectory() && !storyInfo.isSymbolicLink() && rootInfo?.isDirectory() && !rootInfo.isSymbolicLink() && inside(repositoryReal, storyReal) && inside(storyReal, rootReal));
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
				const candidate = join(evidenceRoot, path);
				const info = await lstat(candidate).catch(() => undefined);
				const candidateReal = await realpath(candidate).catch(() => undefined);
				if (!info || !candidateReal) diagnostics.push(diagnostic(`${displayRoot}/${path}`, "Evidence member is missing"));
				else if (info.isSymbolicLink() || !info.isFile() || !rootReal || !inside(rootReal, candidateReal)) { member = false; diagnostics.push(diagnostic(`${displayRoot}/${path}`, "Evidence member is not a contained regular file")); }
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
