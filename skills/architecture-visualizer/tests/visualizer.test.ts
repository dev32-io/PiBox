import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createVisualizerServer, normalizeDocument, validateDocument } from "../scripts/server.mjs";

const validDocument = {
  title: "Flexible graph",
  extraDocumentMeaning: { audience: "developers" },
  views: [{
    id: "overview",
    groups: [{ id: "system", label: "System" }],
    nodes: [
      { id: "agent", kind: "invented-kind", label: "Agent", group: "system", metadata: { arbitrary: true } },
      { id: "note", kind: "note", text: "Meaning, not geometry", position: { x: 1, y: 2 } },
    ],
    edges: [{ source: "note", target: "agent", label: "explains" }],
  }],
};

test("validation permits open semantics while checking renderer references", () => {
  assert.deepEqual(validateDocument(validDocument), { valid: true, errors: [] });
  const invalid = structuredClone(validDocument);
  invalid.views[0]!.edges[0]!.target = "missing";
  const result = validateDocument(invalid);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /missing target/);
});

test("normalization supplies only structural defaults and preserves authored data", () => {
  const normalized = normalizeDocument(validDocument);
  assert.equal(normalized.version, 1);
  assert.deepEqual(normalized.extraDocumentMeaning, { audience: "developers" });
  assert.deepEqual(normalized.views[0]!.nodes[1]!.position, { x: 1, y: 2 });
  assert.deepEqual(normalized.views[0]!.annotations, []);
});

test("server exposes only visualizer routes and retains the last valid document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "architecture-visualizer-"));
  const artifact = join(directory, "visualization.json");
  await writeFile(artifact, JSON.stringify(validDocument));
  const server = await createVisualizerServer({ artifactPath: artifact });
  try {
    const initial = await fetch(`${server.url}api/document`).then((response) => response.json());
    assert.equal(initial.ok, true);
    assert.equal(initial.document.title, "Flexible graph");

    const missing = await fetch(`${server.url}package.json`);
    assert.equal(missing.status, 404);

    await writeFile(artifact, "{ incomplete");
    await new Promise((resolve) => setTimeout(resolve, 180));
    const invalid = await fetch(`${server.url}api/document`).then((response) => response.json());
    assert.equal(invalid.ok, false);
    assert.equal(invalid.document.title, "Flexible graph");
    assert.ok(invalid.errors.length > 0);
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
});
