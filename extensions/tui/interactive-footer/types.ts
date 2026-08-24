import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type InteractiveFooterTone = "accent" | "success" | "warning" | "error" | "muted" | "dim";

export interface InteractiveFooterStatus {
	label: string;
	value?: string;
	marker?: string;
	tone?: InteractiveFooterTone;
	valueTone?: InteractiveFooterTone;
	hidden?: boolean;
}

export interface InteractiveFooterDetailRow {
	kind: "detail";
	label: string;
	value: () => string;
}

export interface InteractiveFooterSettingRow {
	kind: "setting";
	id: string;
	label: string;
	description?: string;
	value: () => string;
	values: readonly string[];
	setValue: (value: string) => void | Promise<void>;
}

export interface InteractiveFooterActionRow {
	kind: "action";
	id: string;
	label: () => string;
	description?: string;
	tone?: InteractiveFooterTone;
	disabled?: () => boolean;
	run: (signal: AbortSignal) => void | Promise<void>;
}

export type InteractiveFooterDialogRow = InteractiveFooterDetailRow | InteractiveFooterSettingRow | InteractiveFooterActionRow;

export interface InteractiveFooterDialogSpec {
	title: string;
	description?: string;
	rows: InteractiveFooterDialogRow[];
}

export interface InteractiveFooterItem {
	id: string;
	section: string;
	order: number;
	status: () => InteractiveFooterStatus;
	dialog: (ctx: ExtensionContext) => InteractiveFooterDialogSpec | Promise<InteractiveFooterDialogSpec>;
}

export interface InteractiveFooterRegistration {
	changed(): void;
	unregister(): void;
}
