import type { VisualCompanionViewer } from "../../../extensions/visual-companion/backend.mjs";

export function validateDocument(input: unknown): { valid: boolean; errors: string[] };
export function normalizeDocument(input: Record<string, unknown>): Record<string, unknown>;
export function loadDocument(path: string): { ok: boolean; document?: unknown; errors: string[] };
export function createArchitectureViewer(assetsDir?: string): VisualCompanionViewer;
export function createVisualizerServer(options: {
	artifactPath: string;
	assetsDir?: string;
	host?: string;
	port?: number;
}): Promise<{
	host: string;
	port: number;
	url: string;
	artifactPath: string;
	close(): Promise<void>;
}>;
