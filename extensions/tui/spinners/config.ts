export interface SpinnerConfig {
	cycleIntervalMs: number;
	typewriterIntervalMs: number;
	statusIntervalMs: number;
	tokensPerCharacter: number;
	typewriter: boolean;
	frames: string[];
	frameIntervalMs: number;
}

export const DEFAULT_SPINNER_CONFIG: Readonly<SpinnerConfig> = {
	cycleIntervalMs: 3_200,
	typewriterIntervalMs: 45,
	statusIntervalMs: 1_000,
	tokensPerCharacter: 4,
	typewriter: true,
	frames: ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "▆", "▅", "▄", "▃", "▂"],
	frameIntervalMs: 90,
};
