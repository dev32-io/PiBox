import type { InteractiveFooterItem, InteractiveFooterRegistration } from "./types.js";

const REGISTRY_KEY = Symbol.for("pibox:interactive-footer-registry");
const LISTENERS_KEY = Symbol.for("pibox:interactive-footer-listeners");

type InteractiveFooterGlobal = typeof globalThis & {
	[REGISTRY_KEY]?: Map<string, InteractiveFooterItem>;
	[LISTENERS_KEY]?: Set<() => void>;
};

function shared(): InteractiveFooterGlobal {
	return globalThis as InteractiveFooterGlobal;
}

const items = shared()[REGISTRY_KEY] ??= new Map<string, InteractiveFooterItem>();
const listeners = shared()[LISTENERS_KEY] ??= new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

export function registerInteractiveFooterItem(item: InteractiveFooterItem): InteractiveFooterRegistration {
	const registration = { ...item } satisfies InteractiveFooterItem;
	items.set(item.id, registration);
	notify();
	return {
		changed: notify,
		unregister() {
			if (items.get(item.id) !== registration) return;
			items.delete(item.id);
			notify();
		},
	};
}

export function getInteractiveFooterItem(id: string): InteractiveFooterItem | undefined {
	return items.get(id);
}

export function listInteractiveFooterItems(section?: string): InteractiveFooterItem[] {
	return [...items.values()]
		.filter((item) => section === undefined || item.section === section)
		.filter((item) => !item.status().hidden)
		.sort((left, right) => left.order - right.order || left.id.localeCompare(right.id));
}

export function subscribeInteractiveFooter(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function resetInteractiveFooterRegistryForTests(): void {
	items.clear();
	listeners.clear();
}
