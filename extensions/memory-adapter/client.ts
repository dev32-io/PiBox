export interface MemoryRecord {
	id: string;
	memory: string;
	metadata?: Record<string, unknown>;
	created_at?: string;
	updated_at?: string;
	expiration_date?: string;
}

export interface Mem0ClientOptions {
	baseUrl: string;
	apiKey?: string;
	timeoutMs?: number;
}

function recordsFrom(value: unknown): MemoryRecord[] {
	if (Array.isArray(value)) return value as MemoryRecord[];
	if (value && typeof value === "object") {
		for (const key of ["results", "memories"]) {
			const candidate = (value as Record<string, unknown>)[key];
			if (Array.isArray(candidate)) return candidate as MemoryRecord[];
		}
	}
	return [];
}

export class Mem0Client {
	readonly baseUrl: string;
	readonly apiKey: string | undefined;
	readonly timeoutMs: number;

	constructor(options: Mem0ClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.apiKey = options.apiKey;
		this.timeoutMs = options.timeoutMs ?? 10_000;
	}

	private async request(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<unknown> {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
		const headers = new Headers(init.headers);
		headers.set("accept", "application/json");
		if (init.body) headers.set("content-type", "application/json");
		if (this.apiKey) headers.set("x-api-key", this.apiKey);
		const response = await fetch(`${this.baseUrl}${path}`, { ...init, headers, signal: combined });
		const text = await response.text();
		if (!response.ok) throw new Error(`Mem0 ${response.status}: ${text.slice(0, 500)}`);
		return text ? JSON.parse(text) : undefined;
	}

	async health(signal?: AbortSignal): Promise<boolean> {
		try {
			const response = await fetch(`${this.baseUrl}/health`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000) });
			return response.ok;
		} catch { return false; }
	}

	async add(memory: string, userId: string, metadata: Record<string, unknown>, expirationDate?: string, signal?: AbortSignal): Promise<MemoryRecord[]> {
		const value = await this.request("/memories", {
			method: "POST",
			body: JSON.stringify({ messages: [{ role: "user", content: memory }], user_id: userId, metadata, infer: false, ...(expirationDate ? { expiration_date: expirationDate } : {}) }),
		}, signal);
		return recordsFrom(value);
	}

	async search(query: string, userId: string, repoId: string, limit: number, signal?: AbortSignal): Promise<MemoryRecord[]> {
		const value = await this.request("/search", {
			method: "POST",
			body: JSON.stringify({ query, user_id: userId, filters: { repo_id: repoId, status: "active" }, limit }),
		}, signal);
		return recordsFrom(value).slice(0, limit);
	}

	async list(userId: string, repoId: string, options: { limit?: number; signal?: AbortSignal } = {}): Promise<MemoryRecord[]> {
		const params = new URLSearchParams({ user_id: userId, repo_id: repoId, show_expired: "true", ...(options.limit ? { limit: String(options.limit) } : {}) });
		return recordsFrom(await this.request(`/memories?${params}`, {}, options.signal));
	}

	private scopedPath(id: string, userId: string, repoId: string, suffix = ""): string {
		const params = new URLSearchParams({ user_id: userId, repo_id: repoId });
		return `/memories/${encodeURIComponent(id)}${suffix}?${params}`;
	}

	async get(id: string, userId: string, repoId: string, signal?: AbortSignal): Promise<MemoryRecord> {
		return await this.request(this.scopedPath(id, userId, repoId), {}, signal) as MemoryRecord;
	}

	async update(id: string, memory: string, metadata: Record<string, unknown> | undefined, userId: string, repoId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(this.scopedPath(id, userId, repoId), { method: "PUT", body: JSON.stringify({ memory, ...(metadata ? { metadata } : {}) }) }, signal);
	}

	async delete(id: string, userId: string, repoId: string, signal?: AbortSignal): Promise<void> {
		await this.request(this.scopedPath(id, userId, repoId), { method: "DELETE" }, signal);
	}

	async history(id: string, userId: string, repoId: string, signal?: AbortSignal): Promise<unknown> {
		return this.request(this.scopedPath(id, userId, repoId, "/history"), {}, signal);
	}
}
