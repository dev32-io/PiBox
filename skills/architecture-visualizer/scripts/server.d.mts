import type { VisualCompanionViewer, VisualDocumentLoadResult } from "../../../extensions/visual-companion/backend.mjs";
export function loadDocument(path: string): Promise<VisualDocumentLoadResult>;
export function createArchitectureViewer(assetsDir?: string): VisualCompanionViewer;
