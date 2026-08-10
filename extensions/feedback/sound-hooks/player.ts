import { spawn } from "node:child_process";

export type SpawnProcess = typeof spawn;

export function playSound(path: string, platform = process.platform, spawnProcess: SpawnProcess = spawn): boolean {
	if (platform !== "darwin") return false;

	try {
		const child = spawnProcess("afplay", [path], {
			detached: true,
			stdio: "ignore",
		});
		child.on("error", () => {});
		child.unref();
		return true;
	} catch {
		return false;
	}
}
