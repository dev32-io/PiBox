import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { VisualCompanionAsset, VisualCompanionRouteContext, VisualCompanionViewer } from "../backend.mjs";

const assetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "assets");

type MockupDocument = { root: string; entry: string };
type MockupState = { lastValid?: MockupDocument };

function isHtml(path: string): boolean {
	return [".html", ".htm"].includes(extname(path).toLowerCase());
}

function isContained(root: string, path: string): boolean {
	return path === root || path.startsWith(`${root}${sep}`);
}

function containedAsset(rootDirectory: string, relativePath: string): string | undefined {
	const root = realpathSync(rootDirectory);
	const lexical = resolve(root, relativePath);
	if (!isContained(root, lexical) || !existsSync(lexical)) return undefined;
	let path: string;
	try { path = realpathSync(lexical); }
	catch { return undefined; }
	return isContained(root, path) ? path : undefined;
}

function documentFor(path: string): MockupDocument | undefined {
	if (!existsSync(path)) return undefined;
	const canonical = realpathSync(path);
	const stats = statSync(canonical);
	if (stats.isFile()) return isHtml(canonical) ? { root: realpathSync(dirname(canonical)), entry: canonical } : undefined;
	if (!stats.isDirectory()) return undefined;
	const root = canonical;
	const entry = containedAsset(root, "index.html");
	return entry && statSync(entry).isFile() ? { root, entry } : undefined;
}

function servedAsset(path: string | undefined): VisualCompanionAsset | undefined {
	return path ? { path, headers: { "access-control-allow-origin": "null" } } : undefined;
}

function contentAsset(route: string, context: VisualCompanionRouteContext): VisualCompanionAsset | undefined {
	if (route !== "/content" && !route.startsWith("/content/")) return undefined;
	const document = (context.state as MockupState | undefined)?.lastValid;
	if (!document) return undefined;
	let relativePath: string;
	try { relativePath = decodeURIComponent(route.slice("/content/".length)); }
	catch { return undefined; }
	if (route === "/content" || route === "/content/") return servedAsset(document.entry);
	const candidate = containedAsset(document.root, relativePath);
	if (!candidate) return undefined;
	if (statSync(candidate).isDirectory()) {
		const index = containedAsset(candidate, "index.html");
		return index && statSync(index).isFile() ? servedAsset(index) : undefined;
	}
	return statSync(candidate).isFile() ? servedAsset(candidate) : undefined;
}

/** Passive browser canvas for one repository-owned HTML mockup file or directory. */
export function createMockupViewer(): VisualCompanionViewer {
	return {
		id: "mockup",
		assetsDir,
		resolveAsset: contentAsset,
		loadDocument(path) {
			const document = documentFor(path);
			return document
				? { ok: true, document, errors: [] }
				: { ok: false, errors: ["Mockup must be an HTML file or a directory containing a physically contained index.html."] };
		},
		watchPath(_artifactPath, document) {
			return (document as MockupDocument).root;
		},
	};
}
