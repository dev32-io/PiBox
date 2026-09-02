export type StoryBoardRoute =
	| { view: "catalog" }
	| { view: "board"; storyId: string; taskId?: string }
	| { view: "documents"; storyId: string; documentId?: string }
	| { view: "reports"; storyId: string; reportId?: string };

export function parseRoute(pathname: string): StoryBoardRoute;
export function pathFor(route: StoryBoardRoute): string;
export function createRequestGate(): {
	next(): { generation: number; signal: AbortSignal };
	current(generation: number): boolean;
	cancel(): void;
};
export function evidencePresentation(item: { available?: boolean; supported?: boolean; manifestMember?: boolean; mediaType?: string }): "missing" | "unsupported" | "image" | "text";
export function renderDeliveryHistory(history?: { executionMode?: string; completedCommit?: string; mergedCommit?: string; [key: string]: unknown }): string;
export function renderMarkdown(markdown?: string): string;
export function createStoryBoardApp(options: { root: HTMLElement; fetchImpl?: typeof fetch; navigationWindow?: Window }): { state: Record<string, unknown>; loadRoute(): Promise<void>; destroy(): void };
