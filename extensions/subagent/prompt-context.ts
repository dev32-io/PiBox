import { createHash } from "node:crypto";
import type { PromptContext, PromptContextHashes } from "./api.js";

export interface PromptContextInput {
	readonly stableSystemParts: readonly string[];
	readonly attemptUserPrompt: string;
}

/** Launch plumbing only. These values must never become effective model content. */
export interface PromptTransportMetadata {
	readonly systemPromptPath?: string;
	readonly transcriptSessionId?: string;
	readonly [key: string]: string | undefined;
}

/**
 * Assemble effective model content. Transport metadata is accepted separately
 * so callers cannot accidentally include paths or transcript identity in it.
 */
export function promptContextHashes(stableSystemContext: string, attemptUserPrompt: string): PromptContextHashes {
	const digest = (value: string) => `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
	return {
		stableSystemContextHash: digest(stableSystemContext),
		attemptUserTurnHash: digest(attemptUserPrompt),
	};
}

export function assemblePromptContext(
	input: PromptContextInput,
	_transport: PromptTransportMetadata,
): PromptContext & PromptContextHashes {
	const stableSystemContext = input.stableSystemParts.map((part) => part.trim()).filter(Boolean).join("\n\n");
	const attemptUserPrompt = input.attemptUserPrompt.trim();
	const hashes = promptContextHashes(stableSystemContext, attemptUserPrompt);
	return { stableSystemContext, attemptUserPrompt, ...hashes };
}
