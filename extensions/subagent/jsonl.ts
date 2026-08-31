import { StringDecoder } from "node:string_decoder";

export interface JsonlStreamParserOptions {
	readonly onValue: (value: unknown) => void;
	readonly onMalformed: (line: string, reason: string) => void;
	readonly maximumLineCharacters?: number;
}

/** Incremental LF-delimited JSON parser. EOF is an authoritative final record boundary. */
export class JsonlStreamParser {
	private readonly decoder = new StringDecoder("utf8");
	private remainder = "";
	private discardingOversizedLine = false;
	private ended = false;
	private readonly maximumLineCharacters: number;

	constructor(private readonly options: JsonlStreamParserOptions) {
		this.maximumLineCharacters = options.maximumLineCharacters ?? 1024 * 1024;
		if (!Number.isInteger(this.maximumLineCharacters) || this.maximumLineCharacters < 1) {
			throw new Error("maximumLineCharacters must be a positive integer");
		}
	}

	write(chunk: Buffer | string): void {
		if (this.ended) throw new Error("Cannot write JSONL after EOF");
		this.consume(typeof chunk === "string" ? chunk : this.decoder.write(chunk));
	}

	end(): void {
		if (this.ended) return;
		this.ended = true;
		this.consume(this.decoder.end());
		if (this.discardingOversizedLine) {
			this.discardingOversizedLine = false;
			return;
		}
		if (this.remainder.length > 0) this.parse(this.remainder);
		this.remainder = "";
	}

	private consume(text: string): void {
		if (!text) return;
		let start = 0;
		for (;;) {
			const newline = text.indexOf("\n", start);
			if (newline < 0) {
				this.retain(text.slice(start));
				return;
			}
			this.retain(text.slice(start, newline));
			if (this.discardingOversizedLine) this.discardingOversizedLine = false;
			else this.parse(this.remainder);
			this.remainder = "";
			start = newline + 1;
		}
	}

	private retain(fragment: string): void {
		if (this.discardingOversizedLine || !fragment) return;
		this.remainder += fragment;
		if (this.remainder.length <= this.maximumLineCharacters) return;
		this.options.onMalformed(this.remainder.slice(0, this.maximumLineCharacters), "JSONL record exceeds the configured limit");
		this.remainder = "";
		this.discardingOversizedLine = true;
	}

	private parse(line: string): void {
		if (!line.trim()) return;
		try { this.options.onValue(JSON.parse(line) as unknown); }
		catch (error) {
			this.options.onMalformed(line, error instanceof Error ? error.message : String(error));
		}
	}
}
