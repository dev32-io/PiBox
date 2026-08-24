import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const REGISTRY_KEY = Symbol.for("pibox:profile-registry");
type RegistryGlobal = typeof globalThis & { [REGISTRY_KEY]?: Set<string> };

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
