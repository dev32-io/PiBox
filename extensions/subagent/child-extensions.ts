import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FAST_MODE_EXTENSION_PATH } from "../fast-mode/index.js";

const EXTENSIONS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const MEMORY_EXTENSION_PATH = resolve(EXTENSIONS_ROOT, "memory-adapter/index.ts");
export const DISTILL_EXTENSION_PATH = resolve(EXTENSIONS_ROOT, "distill/index.ts");

/** Generic child capabilities; workflow orchestration is intentionally absent. */
export const STANDALONE_CHILD_EXTENSION_PATHS = [
	MEMORY_EXTENSION_PATH,
	DISTILL_EXTENSION_PATH,
	FAST_MODE_EXTENSION_PATH,
] as const;
