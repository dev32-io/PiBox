import type { IncomingMessage, ServerResponse } from "node:http";

export interface VisualDocumentLoadResult {
	ok: boolean;
	document?: unknown;
	errors: string[];
}

export interface VisualCompanionRouteContext {
	url: URL;
	viewerId?: string;
	state?: unknown;
	backend: VisualCompanionBackend;
}

export type VisualCompanionRouteHandler = (
	request: IncomingMessage,
	response: ServerResponse,
	context: VisualCompanionRouteContext,
) => void | Promise<void>;

export interface VisualCompanionViewer {
	id: string;
	assetsDir?: string;
	routes?: Record<string, string>;
	handlers?: Record<string, VisualCompanionRouteHandler>;
	loadDocument?(path: string): VisualDocumentLoadResult;
	close?(): void | Promise<void>;
}

export interface VisualCompanionSelection {
	viewerId: string;
	artifactPath?: string;
	url: string;
	viewerUrl: string;
	valid?: boolean;
	errors?: string[];
}

export interface VisualCompanionBackend {
	host: string;
	port: number;
	url: string;
	readonly viewers: string[];
	readonly selectedViewer?: string;
	registerViewer(viewer: VisualCompanionViewer): () => void;
	select(viewerId: string): string;
	show(input: { viewerId: string; artifactPath?: string }): VisualCompanionSelection;
	close(): Promise<void>;
}

export function createVisualCompanionBackend(options?: {
	viewers?: VisualCompanionViewer[];
	host?: string;
	port?: number;
	commonAssetsDir?: string;
	commonRoutes?: Record<string, string>;
	commonHandlers?: Record<string, VisualCompanionRouteHandler>;
}): Promise<VisualCompanionBackend>;
