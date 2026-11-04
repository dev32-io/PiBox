import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { PermissionMode } from "./types.js";

export function permissionModeDisplay(mode: PermissionMode): { marker: string; value: string; token: ThemeColor } {
	return mode === "bypass" ? { marker: "⚠", value: "Bypass", token: "warning" } : { marker: "◆", value: "Enforced", token: "success" };
}

export function renderPermissionMode(mode: PermissionMode, theme: Theme): string {
	const { marker, value, token } = permissionModeDisplay(mode);
	return `${theme.fg(token, marker)} ${theme.fg("dim", "Permissions:")} ${theme.bold(theme.fg(token, value))}`;
}
