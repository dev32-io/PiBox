export interface VisualDocumentLoadResult {
	ok: boolean;
	document?: unknown;
	errors: string[];
}

export interface VisualCompanionViewer {
	id: string;
	assetsDir: string;
	routes?: Record<string, string>;
	loadDocument(path: string): VisualDocumentLoadResult;
}

export interface VisualCompanionBackend {
	host: string;
	port: number;
	url: string;
	viewers: string[];
	show(input: { viewerId: string; artifactPath: string }): {
		viewerId: string;
		artifactPath: string;
		url: string;
		valid: boolean;
		errors: string[];
	};
	close(): Promise<void>;
}

export function createVisualCompanionBackend(options: {
	viewers: VisualCompanionViewer[];
	host?: string;
	port?: number;
}): Promise<VisualCompanionBackend>;
