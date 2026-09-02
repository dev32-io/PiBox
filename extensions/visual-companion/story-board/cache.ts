/** Session-owned projection cache. Rejected work is deliberately never retained. */
export class StoryBoardCache {
	private readonly completed = new Map<string, unknown>();
	private readonly inFlight = new Map<string, Promise<unknown>>();
	private generation = 0;
	private closed = false;

	get size(): number { return this.completed.size; }
	get pending(): number { return this.inFlight.size; }

	read<T>(key: string, load: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Error("Story Board cache is closed."));
		if (this.completed.has(key)) return Promise.resolve(this.completed.get(key) as T);
		const existing = this.inFlight.get(key);
		if (existing) return existing as Promise<T>;
		const generation = this.generation;
		const operation = Promise.resolve().then(load);
		this.inFlight.set(key, operation);
		void operation.then((value) => {
			if (!this.closed && generation === this.generation && this.inFlight.get(key) === operation) this.completed.set(key, value);
		}, () => {}).finally(() => {
			if (this.inFlight.get(key) === operation) this.inFlight.delete(key);
		});
		return operation;
	}

	invalidate(): void {
		if (this.closed) return;
		this.generation += 1;
		this.completed.clear();
		this.inFlight.clear();
	}

	close(): void {
		this.closed = true;
		this.generation += 1;
		this.completed.clear();
		this.inFlight.clear();
	}
}
