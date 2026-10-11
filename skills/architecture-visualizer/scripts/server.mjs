import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultAssetsDir = resolve(dirname(fileURLToPath(import.meta.url)), "../assets");

export async function loadDocument(artifactPath) {
  try {
    if (extname(artifactPath).toLowerCase() !== ".c4") {
      return { ok: false, errors: ["Architecture now requires one self-contained native LikeC4 .c4 file. Preserve this legacy JSON; reauthor its elements, relationships and views in a new .c4 file using skills/architecture-visualizer/templates/example.c4, then open that file. Renaming JSON is not conversion."] };
    }
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    if (major < 22 || (major === 22 && (minor < 22 || (minor === 22 && patch < 3)))) {
      throw new Error("Architecture requires Node >=22.22.3 (LikeC4 1.59.4). Upgrade Node; other Visual Companion viewers remain available.");
    }
    const source = readFileSync(artifactPath, "utf8");
    const revision = createHash("sha256").update(source).digest("hex");
    // Deliberately no workspace/config/CLI path or caller-controlled options.
    const { LikeC4 } = await import("likec4");
    const instance = await LikeC4.fromSource(source, { graphviz: "wasm", logger: false, printErrors: false });
    try {
      const errors = instance.getErrors().map(({ message, line }) => `Line ${line}: ${message}`);
      if (errors.length) return { ok: false, errors };
      const model = await instance.layoutedModel();
      return { ok: true, errors: [], document: { revision, model: model.$data } };
    } finally {
      await instance.dispose();
    }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

export function createArchitectureViewer(assetsDir = defaultAssetsDir) {
  return { id: "architecture", assetsDir, loadDocument };
}
