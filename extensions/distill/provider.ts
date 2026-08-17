export const DISTILL_KNOWLEDGE_DISCOVERY_EVENT = "pibox:distill:discover-knowledge-providers";

export interface DistillKnowledgeItem {
	provider: string;
	id: string;
	kind: string;
	content: string;
	evidence: string[];
	metadata?: Record<string, unknown>;
}

export interface DistillKnowledgeProvider {
	id: string;
	locality: "local" | "remote";
	description: string;
	search(query: string, options: { cwd: string; limit: number; signal?: AbortSignal }): Promise<DistillKnowledgeItem[]>;
}

export interface DistillKnowledgeDiscovery {
	register(provider: DistillKnowledgeProvider): void;
}
