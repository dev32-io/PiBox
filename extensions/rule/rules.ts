import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchesGlob } from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface RuleDefinition {
	id: string;
	label: string;
	path: string;
	content: string;
	paths: string[];
	scope: "user" | "project";
	format: "claude" | "pi";
}

export interface RuleDiagnostic {
	path: string;
	message: string;
}

export interface RuleDiscovery {
	projectRoot: string;
	rules: RuleDefinition[];
	diagnostics: RuleDiagnostic[];
}

type RuleFrontmatter = { paths?: unknown };

function repositoryRoot(cwd: string): string {
	let current = resolve(cwd);
	while (true) {
		if (existsSync(join(current, ".git"))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

function markdownFiles(root: string): string[] {
	if (!existsSync(root)) return [];
	const files: string[] = [];
	const visited = new Set<string>();
	const walk = (directory: string) => {
		let canonical: string;
		try { canonical = realpathSync(directory); } catch { return; }
		if (visited.has(canonical)) return;
		visited.add(canonical);
		let entries;
		try { entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name)); }
		catch { return; }
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory() || entry.isSymbolicLink() && existsSync(path) && !entry.name.endsWith(".md")) walk(path);
			else if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) files.push(path);
		}
	};
	walk(root);
	return files;
}

function ruleLabel(path: string, root: string): string {
	const value = relative(root, path).replaceAll(sep, "/").replace(/\.md$/i, "");
	return value || basename(path, ".md");
}

function parseRule(path: string, root: string, scope: RuleDefinition["scope"], format: RuleDefinition["format"]): RuleDefinition {
	const parsed = parseFrontmatter<RuleFrontmatter>(readFileSync(path, "utf8"));
	let paths: string[] = [];
	if (parsed.frontmatter.paths !== undefined) {
		if (!Array.isArray(parsed.frontmatter.paths) || parsed.frontmatter.paths.some((value) => typeof value !== "string" || !value.trim())) {
			throw new Error("paths frontmatter must be a non-empty string array");
		}
		paths = parsed.frontmatter.paths.map((value) => (value as string).trim());
	}
	if (!parsed.body.trim()) throw new Error("rule body must not be empty");
	return {
		id: realpathSync(path),
		label: ruleLabel(path, root),
		path: realpathSync(path),
		content: parsed.body.trim(),
		paths,
		scope,
		format,
	};
}

export function discoverRules(cwd: string, home = homedir()): RuleDiscovery {
	const projectRoot = repositoryRoot(cwd);
	const sources = [
		{ root: join(home, ".claude", "rules"), scope: "user", format: "claude" },
		{ root: join(home, ".pi", "agent", "rules"), scope: "user", format: "pi" },
		{ root: join(projectRoot, ".claude", "rules"), scope: "project", format: "claude" },
		{ root: join(projectRoot, ".pi", "rules"), scope: "project", format: "pi" },
	] as const;
	const rules: RuleDefinition[] = [];
	const diagnostics: RuleDiagnostic[] = [];
	const seen = new Set<string>();
	for (const source of sources) {
		for (const path of markdownFiles(source.root)) {
			try {
				const rule = parseRule(path, source.root, source.scope, source.format);
				if (seen.has(rule.id)) continue;
				seen.add(rule.id);
				rules.push(rule);
			} catch (error) {
				diagnostics.push({ path, message: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return { projectRoot, rules, diagnostics };
}

function normalizedRelative(root: string, target: string): string | undefined {
	const value = relative(root, target).replaceAll(sep, "/");
	if (value === ".." || value.startsWith("../")) return undefined;
	return value || ".";
}

function pathMatches(pattern: string, relativePath: string, absolutePath: string, projectRoot: string): boolean {
	try {
		if (isAbsolute(pattern)) return matchesGlob(absolutePath, pattern);
		const normalized = pattern.replace(/^\.\//, "").replaceAll("\\", "/");
		return matchesGlob(relativePath, normalized) || matchesGlob(absolutePath, resolve(projectRoot, normalized));
	} catch {
		return false;
	}
}

export function rulesForRead(discovery: RuleDiscovery, inputPath: string, cwd: string, alreadyLoaded: ReadonlySet<string> = new Set()): RuleDefinition[] {
	const absolutePath = resolve(cwd, inputPath);
	const relativePath = normalizedRelative(discovery.projectRoot, absolutePath);
	return discovery.rules.filter((rule) => {
		if (alreadyLoaded.has(rule.id) || rule.paths.length === 0) return false;
		if (absolutePath === rule.path) return true;
		if (!relativePath) return false;
		return rule.paths.some((pattern) => pathMatches(pattern, relativePath, absolutePath, discovery.projectRoot));
	});
}

export function unconditionalRules(discovery: RuleDiscovery): RuleDefinition[] {
	return discovery.rules.filter((rule) => rule.paths.length === 0);
}

export function renderRules(rules: readonly RuleDefinition[], heading: string): string {
	if (rules.length === 0) return "";
	return [
		`## ${heading}`,
		"Apply the following repository instructions to the work within their scope.",
		...rules.flatMap((rule) => [`\n### ${rule.label}`, `Source: ${rule.path}`, rule.content]),
	].join("\n");
}
