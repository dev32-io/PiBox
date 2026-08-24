import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { availableProfiles, PROFILE_STATUS_KEY, resetActiveProfile, selectedProfile, setActiveProfile } from "./registry.js";

/** Startup-only named profiles. An omitted/default profile leaves Pi unchanged. */
export default function profileExtension(pi: ExtensionAPI): void {
	pi.registerFlag("profile", {
		description: "Start Pi with a named PiBox profile (default: default)",
		type: "string",
	});

	pi.on("session_start", (_event, ctx) => {
		const selected = selectedProfile(pi);
		if (!availableProfiles().includes(selected)) {
			throw new Error(`Unknown PiBox profile \"${selected}\". Available profiles: ${availableProfiles().join(", ")}`);
		}
		setActiveProfile(selected);
		if (selected !== "default" && ctx.hasUI) ctx.ui.setStatus(PROFILE_STATUS_KEY, `profile:${selected}`);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		resetActiveProfile();
		if (ctx.hasUI) ctx.ui.setStatus(PROFILE_STATUS_KEY, undefined);
	});
}
