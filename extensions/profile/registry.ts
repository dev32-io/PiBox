import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REGISTRY_KEY = Symbol.for("pibox:profile-registry");
const ACTIVE_PROFILE_KEY = Symbol.for("pibox:active-profile");
type RegistryGlobal = typeof globalThis & {
	[REGISTRY_KEY]?: Set<string>;
	[ACTIVE_PROFILE_KEY]?: string;
};

const registryGlobal = globalThis as RegistryGlobal;
const profiles = registryGlobal[REGISTRY_KEY] ??= new Set<string>();
profiles.add("default");

export const PROFILE_STATUS_KEY = "pibox-profile";

export function registerProfile(name: string): void {
	const normalized = name.trim();
	if (!normalized || normalized.includes("/")) throw new Error(`Invalid profile name: ${name}`);
	profiles.add(normalized);
}

export function availableProfiles(): string[] {
	return [...profiles].sort();
}

export function selectedProfile(pi: Pick<ExtensionAPI, "getFlag">): string {
	const value = pi.getFlag("profile");
	return typeof value === "string" && value.trim() ? value.trim() : "default";
}

export function setActiveProfile(name: string): void {
	registryGlobal[ACTIVE_PROFILE_KEY] = name;
}

export function activeProfile(): string {
	return registryGlobal[ACTIVE_PROFILE_KEY] ?? "default";
}

export function resetActiveProfile(): void {
	delete registryGlobal[ACTIVE_PROFILE_KEY];
}
