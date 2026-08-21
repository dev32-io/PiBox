import type { Theme } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./types.js";

export function renderPermissionMode(mode: PermissionMode, theme: Theme): string {
	if (mode === "bypass") return `${theme.fg("warning", "⚠")} ${theme.fg("dim", "Permissions:")} ${theme.bold(theme.fg("warning", "Bypass"))}`;
	return `${theme.fg("success", "◆")} ${theme.fg("dim", "Permissions:")} ${theme.bold(theme.fg("success", "Enforced"))}`;
}
