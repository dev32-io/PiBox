import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createVisualCompanionBackend } from "../../../extensions/visual-companion/backend.mjs";

const require = createRequire(import.meta.url);
const skillRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultAssetsDir = resolve(skillRoot, "assets");
const cytoscapePath = require.resolve("cytoscape/dist/cytoscape.min.js");

function text(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function validateDocument(input) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, errors: ["The document must be a JSON object."] };
  }
  if (!Array.isArray(input.views)) errors.push("document.views must be an array.");

  for (const [viewIndex, view] of (Array.isArray(input.views) ? input.views : []).entries()) {
    const prefix = `views[${viewIndex}]`;
    if (!view || typeof view !== "object" || Array.isArray(view)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }
    if (!text(view.id)) errors.push(`${prefix}.id must be a non-empty string.`);
    const ids = new Set();
    const nodeIds = new Set();
    for (const [collectionName, items] of [["groups", view.groups], ["nodes", view.nodes], ["annotations", view.annotations]]) {
      if (items !== undefined && !Array.isArray(items)) {
        errors.push(`${prefix}.${collectionName} must be an array when present.`);
        continue;
      }
      for (const [index, item] of (items ?? []).entries()) {
        const itemPrefix = `${prefix}.${collectionName}[${index}]`;
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          errors.push(`${itemPrefix} must be an object.`);
          continue;
        }
        const id = text(item.id);
        if (!id) errors.push(`${itemPrefix}.id must be a non-empty string.`);
        else if (ids.has(id)) errors.push(`${itemPrefix}.id duplicates "${id}" in this view.`);
        else {
          ids.add(id);
          if (collectionName !== "groups") nodeIds.add(id);
        }
      }
    }
    if (view.edges !== undefined && !Array.isArray(view.edges)) errors.push(`${prefix}.edges must be an array when present.`);
    for (const [edgeIndex, edge] of (view.edges ?? []).entries()) {
      const edgePrefix = `${prefix}.edges[${edgeIndex}]`;
      if (!edge || typeof edge !== "object" || Array.isArray(edge)) {
        errors.push(`${edgePrefix} must be an object.`);
        continue;
      }
      const source = text(edge.source ?? edge.from);
      const target = text(edge.target ?? edge.to);
      if (!source) errors.push(`${edgePrefix} needs source (or from).`);
      else if (!nodeIds.has(source)) errors.push(`${edgePrefix} references missing source "${source}".`);
      if (!target) errors.push(`${edgePrefix} needs target (or to).`);
      else if (!nodeIds.has(target)) errors.push(`${edgePrefix} references missing target "${target}".`);
    }
  }
  return { valid: errors.length === 0, errors };
}

export function normalizeDocument(input) {
  const document = structuredClone(input);
  document.version ??= 1;
  document.title ??= "Architecture visualization";
  document.views = (document.views ?? []).map((view) => ({
    ...view,
    groups: view.groups ?? [],
    nodes: view.nodes ?? [],
    annotations: view.annotations ?? [],
    edges: view.edges ?? [],
  }));
  return document;
}

export function loadDocument(artifactPath) {
  try {
    const parsed = JSON.parse(readFileSync(artifactPath, "utf8"));
    const validation = validateDocument(parsed);
    return validation.valid
      ? { ok: true, document: normalizeDocument(parsed), errors: [] }
      : { ok: false, errors: validation.errors };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function createArchitectureViewer(assetsDir = defaultAssetsDir) {
  return {
    id: "architecture",
    assetsDir,
    routes: { "/vendor/cytoscape.js": cytoscapePath },
    loadDocument,
  };
}

export async function createVisualizerServer({ artifactPath, assetsDir = defaultAssetsDir, host = "127.0.0.1", port = 0 } = {}) {
  if (!artifactPath) throw new Error("artifactPath is required");
  const backend = await createVisualCompanionBackend({ viewers: [createArchitectureViewer(assetsDir)], host, port });
  try {
    const shown = backend.show({ viewerId: "architecture", artifactPath });
    return {
      host: backend.host,
      port: backend.port,
      url: shown.url,
      artifactPath: shown.artifactPath,
      close: () => backend.close(),
    };
  } catch (error) {
    await backend.close();
    throw error;
  }
}

