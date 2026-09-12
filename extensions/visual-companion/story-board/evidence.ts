import { constants } from "node:fs";
import { lstat, open, readFile, realpath } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";
import { parseStoryRuntimeState } from "../../workflow/story-runtime-store.js";
import type { StoryRuntimeState } from "../../workflow/story-runtime-store.js";
import type { Diagnostic, E2ECaseEvidenceRef, E2ECaseProjection, EvidenceMetadata, RecordedE2EReportProjection } from "./models.js";

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
function redactAuthorizationCredentials(value: string): string {
	const quotedKey = String.raw`(?:"authorization"|'authorization'|\bauthorization\b)`;
	let sanitized = value;
	for (const quote of ['"', "'", "`"]) {
		const escapedQuote = quote === "`" ? "`" : `\\${quote}`;
		const quotedValue = new RegExp(`(${quotedKey}\\s*[:=]\\s*)${escapedQuote}((?:\\\\.|[^${escapedQuote}\\\\\\r\\n])*)${escapedQuote}`, "gi");
		sanitized = sanitized.replace(quotedValue, `$1${quote}[REDACTED AUTHORIZATION]${quote}`);
	}
	return sanitized.replace(new RegExp(`(${quotedKey}\\s*)([:=])(\\s*)(?!["'\\x60])([^\\r\\n]*)`, "gi"), (match, key: string, separator: string, spacing: string, credential: string) => {
		if (!credential) return match;
		const suffixAt = separator === "=" ? credential.search(/[;,]/) : -1;
		const suffix = suffixAt >= 0 ? credential.slice(suffixAt) : "";
		return `${key}${separator}${spacing}[REDACTED AUTHORIZATION]${suffix}`;
	});
}
export function sanitizeCurrentEvidenceText(value: string): string {
	return redactAuthorizationCredentials(value)
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[REDACTED PRIVATE MATERIAL]")
		.replace(/\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
		.replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED TOKEN]")
		.replace(/(["'`])((?:[A-Za-z]:[\\/]|\/)[^"'`\r\n]*)\1/g, (_match, quote: string) => `${quote}[private path]${quote}`)
		.replace(/(^|[\s=(\[\]{},;])((?:[A-Za-z]:[\\/]|\/)[^\s"'`),;\]}]*)/g, "$1[private path]");
}
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

function stringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? value.map((item) => sanitizeCurrentEvidenceText(item)) : undefined;
}

function parseE2EReport(value: unknown, sourcePath: string, sourceMemberPath: string, evidence: readonly EvidenceMetadata[]): RecordedE2EReportProjection | "supporting" | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (!("caseResults" in record)) return "supporting";
	if (typeof record.result !== "string" || typeof record.summary !== "string") return undefined;
	const findings = stringArray(record.findings); if (!findings || !Array.isArray(record.caseResults)) return undefined;
	const seen = new Set<string>(); const cases: E2ECaseProjection[] = [];
	for (const candidate of record.caseResults) {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return undefined;
		const item = candidate as Record<string, unknown>;
		const actions = stringArray(item.executedActions); const observations = stringArray(item.observations); const refs = stringArray(item.evidenceRefs);
		if (typeof item.caseId !== "string" || !item.caseId || typeof item.status !== "string" || !item.status || !actions || !observations || !refs || seen.has(item.caseId)) return undefined;
		seen.add(item.caseId);
		const evidenceRefs: E2ECaseEvidenceRef[] = refs.map((label) => {
			const authorized = evidence.find((entry) => entry.memberPath === label);
			return { label, ...(authorized?.manifestMember && authorized.available && authorized.supported ? { memberPath: authorized.memberPath } : {}) };
		});
		cases.push({ caseId: sanitizeCurrentEvidenceText(item.caseId), status: sanitizeCurrentEvidenceText(item.status), executedActions: actions, observations, evidenceRefs, recorded: true });
	}
	return { sourcePath, sourceMemberPath, result: sanitizeCurrentEvidenceText(record.result), summary: sanitizeCurrentEvidenceText(record.summary), findings, cases, diagnostics: [] };
}

async function readAuthorizedCurrentEvidenceJson(repositoryRoot: string, storyId: string, memberPath: string): Promise<unknown> {
	if (!ID.test(storyId) || !safeRelative(memberPath) || !memberPath.startsWith("evidence/")) throw new Error("unsafe evidence path");
	const repository = resolve(repositoryRoot); const storyRoot = join(repository, "agent-artifacts", storyId);
	const [repositoryReal, storyReal] = await Promise.all([realpath(repository), realpath(storyRoot)]);
	if (!inside(repositoryReal, storyReal)) throw new Error("story is not contained");
	const member = await regularMember(storyRoot, memberPath);
	if (member.invalid || !member.info?.isFile() || !member.real || !inside(storyReal, member.real)) throw new Error("evidence is not contained");
	const handle = await open(join(storyRoot, memberPath), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
	try {
		const descriptor = await handle.stat();
		if (!descriptor.isFile() || descriptor.dev !== member.info.dev || descriptor.ino !== member.info.ino) throw new Error("evidence changed while opening");
		return JSON.parse((await handle.readFile()).toString("utf8"));
	} finally { await handle.close(); }
}

/** Selects the newest usable report from exact current E2E references; it never discovers files. */
export async function readCurrentE2EReport(repositoryRoot: string, storyId: string, evidenceRefs: readonly string[], evidence: readonly EvidenceMetadata[]): Promise<RecordedE2EReportProjection | undefined> {
	const failures: Diagnostic[] = [];
	for (const reference of [...evidenceRefs].reverse()) {
		if (extname(reference).toLowerCase() !== ".json") continue;
		const metadata = evidence.find((entry) => entry.memberPath === reference);
		if (!metadata?.manifestMember || !metadata.available) {
			failures.push(diagnostic(`agent-artifacts/${storyId}/${reference}`, "Recorded E2E report candidate is unavailable"));
			continue;
		}
		let parsed: unknown;
		try { parsed = await readAuthorizedCurrentEvidenceJson(repositoryRoot, storyId, reference); }
		catch { failures.push(diagnostic(`agent-artifacts/${storyId}/${reference}`, "Recorded E2E report candidate is unreadable or malformed")); continue; }
		const report = parseE2EReport(parsed, metadata.path ?? `agent-artifacts/${storyId}/${reference}`, reference, evidence);
		if (report === "supporting") continue;
		if (!report) { failures.push(diagnostic(`agent-artifacts/${storyId}/${reference}`, "Recorded E2E report candidate has an invalid case-results contract")); continue; }
		if (failures.length) report.diagnostics.push(...failures, diagnostic(report.sourcePath, "Showing this earlier report because a newer candidate was unavailable or malformed"));
		return report;
	}
	return failures.length ? { sourcePath: "", sourceMemberPath: "", result: "Unavailable", summary: "No usable recorded E2E case report is available.", findings: [], cases: [], diagnostics: failures } : undefined;
}

/** Reads authoritative current state through one contained, no-follow descriptor. */
export async function readCurrentRuntimeState(repositoryRoot: string, storyId: string, storyRoot = join(resolve(repositoryRoot), "agent-artifacts", storyId)): Promise<{ bytes: Buffer; state: StoryRuntimeState }> {
	if (!ID.test(storyId)) throw new Error("invalid story id");
	const repository = resolve(repositoryRoot); const storyInfo = await lstat(storyRoot).catch(() => undefined);
	const [repositoryReal, storyReal] = await Promise.all([realpath(repository).catch(() => undefined), realpath(storyRoot).catch(() => undefined)]);
	if (!storyInfo?.isDirectory() || storyInfo.isSymbolicLink() || !repositoryReal || !storyReal || !inside(repositoryReal, storyReal)) throw new Error("story is not contained");
	const stateMember = await regularMember(storyRoot, "state.yaml");
	if (stateMember.invalid || !stateMember.info?.isFile() || !stateMember.real || !inside(storyReal, stateMember.real)) throw new Error("state is not contained");
	const handle = await open(join(storyRoot, "state.yaml"), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const info = await handle.stat(); if (!info.isFile()) throw new Error("state is not a regular file");
		const bytes = await handle.readFile();
		return { bytes, state: parseStoryRuntimeState(parse(bytes.toString("utf8")), storyId) };
	} finally { await handle.close(); }
}

/** Re-validates current state authority and the cited member without following symlinks in any path component. */
export async function resolveCurrentEvidenceMember(repositoryRoot: string, storyId: string, memberPath: string): Promise<string | undefined> {
	if (!ID.test(storyId) || !safeRelative(memberPath) || !memberPath.startsWith("evidence/")) return undefined;
	const repository = resolve(repositoryRoot); const storyRoot = join(repository, "agent-artifacts", storyId); const storyInfo = await lstat(storyRoot).catch(() => undefined);
	const [repositoryReal, storyReal] = await Promise.all([realpath(repository).catch(() => undefined), realpath(storyRoot).catch(() => undefined)]); if (!storyInfo?.isDirectory() || storyInfo.isSymbolicLink() || !repositoryReal || !storyReal || !inside(repositoryReal, storyReal)) return undefined;
	let evidenceRefs: readonly string[]; try { evidenceRefs = (await readCurrentRuntimeState(repositoryRoot, storyId, storyRoot)).state.e2e.evidenceRefs; } catch { return undefined; }
	if (!evidenceRefs.includes(memberPath)) return undefined;
	const { info, real, invalid } = await regularMember(storyRoot, memberPath); if (invalid || !info?.isFile() || !real || !inside(storyReal, real)) return undefined;
	return join(storyRoot, memberPath);
}
