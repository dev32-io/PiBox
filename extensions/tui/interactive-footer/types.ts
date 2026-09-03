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
	/** Applied only after Enter confirms the dialog. Arrow-key previews do not call this. */
	setValue: (value: string) => void | Promise<void>;
}

export interface InteractiveFooterNoticeRow {
	kind: "notice";
	text: () => string;
	tone?: InteractiveFooterTone | (() => InteractiveFooterTone | undefined);
	hidden?: () => boolean;
}

export interface InteractiveFooterActionRow {
	kind: "action";
	id: string;
	label: () => string;
	description?: string | (() => string);
	tone?: InteractiveFooterTone | (() => InteractiveFooterTone | undefined);
	disabled?: () => boolean;
	/** Successful actions close by default; set false only when the refreshed dialog must remain open. */
	closeOnSuccess?: boolean;
	run: (signal: AbortSignal) => void | Promise<void>;
}

export type InteractiveFooterDialogRow = InteractiveFooterDetailRow | InteractiveFooterSettingRow | InteractiveFooterNoticeRow | InteractiveFooterActionRow;

export interface InteractiveFooterRowsDialogSpec {
	kind?: "rows";
	title: string;
	description?: string;
	rows: InteractiveFooterDialogRow[];
}

export interface InteractiveFooterChoice {
	value: string;
	label: string;
	marker?: string;
	description?: string;
	disabled?: () => boolean;
}

export interface InteractiveFooterChoiceNotice {
	text: string;
	tone?: InteractiveFooterTone;
}

/** Reusable single-choice dialog: arrows preview, Enter confirms, Escape cancels. */
export interface InteractiveFooterChoiceDialogSpec {
	kind: "choice";
	title: string;
	description?: string;
	value: () => string;
	choices: readonly InteractiveFooterChoice[];
	notice?: (selectedValue: string) => InteractiveFooterChoiceNotice | undefined;
	confirm: (selectedValue: string, signal: AbortSignal) => void | Promise<void>;
}

export type InteractiveFooterDialogSpec = InteractiveFooterRowsDialogSpec | InteractiveFooterChoiceDialogSpec;

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
