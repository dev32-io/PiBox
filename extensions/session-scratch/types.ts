export interface SessionScratchBinding {
	/** Opaque identifier persisted by the caller; it contains no repository or session name. */
	workspaceId: string;
	/** Pi session that owns this workspace. */
	sessionId: string;
}

export interface SessionScratchPaths {
	root: string;
	meta: string;
	plan: string;
	ledger: string;
	scripts: string;
	results: string;
}

export interface SessionScratchWorkspace {
	binding: SessionScratchBinding;
	paths: SessionScratchPaths;
}
