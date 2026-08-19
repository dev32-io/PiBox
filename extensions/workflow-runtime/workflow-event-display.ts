import type { Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, type Component } from "@earendil-works/pi-tui";

export interface WorkflowEventDisplayDetails {
	workflowRef?: string;
	title?: string;
	detail?: string;
	attention?: boolean;
	kind?: string;
	fromStatus?: string;
	toStatus?: string;
	nextAction?: string;
	[key: string]: unknown;
}

function words(value: string): string {
	return value.split(/[_-]+/).filter(Boolean).map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`).join(" ");
}

function compact(value: unknown, limit: number): string {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
	return normalized.length > limit ? `${normalized.slice(0, Math.max(0, limit - 1))}…` : normalized;
}

export function workflowEventHeadline(details: WorkflowEventDisplayDetails): string {
	const kind = compact(details.kind, 48);
	const from = compact(details.fromStatus, 32);
	const to = compact(details.toStatus, 32);
	const transition = from && to ? `${from} → ${to}` : to || from;
	const type = kind ? words(kind) : "Event";
	const title = compact(details.title, 110);
	return [`Workflow event`, type, transition].filter(Boolean).join(" · ") + (title ? ` — ${title}` : "");
}

export function renderWorkflowEventMessage(
	message: { content: unknown; details?: unknown },
	options: { expanded: boolean; outputPad: number },
	theme: Theme,
): Component {
	const details = message.details && typeof message.details === "object" && !Array.isArray(message.details)
		? message.details as WorkflowEventDisplayDetails
		: {};
	const component = new Container();
	const attention = details.attention === true;
	const icon = attention ? theme.fg("error", "⚠") : theme.fg("accent", "◆");
	const headline = workflowEventHeadline(details);
	component.addChild(new Text(`${icon} ${theme.bold(theme.fg(attention ? "error" : "customMessageLabel", headline))}`, options.outputPad, 0));
	if (options.expanded) {
		const fullDetails = Object.keys(details).length > 0
			? JSON.stringify(details, null, 2)
			: typeof message.content === "string" ? message.content : JSON.stringify(message.content, null, 2);
		component.addChild(new Text(theme.fg("customMessageText", fullDetails), options.outputPad + 2, 0));
	}
	return component;
}
