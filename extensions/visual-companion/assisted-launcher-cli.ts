#!/usr/bin/env node
import { parseArgs } from "node:util";
import { launchAssistedVisualCompanion } from "./assisted-launcher.js";
import { createAssistedFixtureRepository, type AssistedFixtureRepository } from "./story-board/fixtures.js";

const usage = `Visual Companion assisted E2E launcher

Usage:
  npx tsx extensions/visual-companion/assisted-launcher-cli.ts [options]

Options:
  --repository-root <path>       Use an existing repository (default: disposable canonical fixture)
  --architecture-artifact <path> Architecture JSON (default: canonical fixture artifact)
  --discovery-delay-ms <number>  Fixture-only delay, bounded to 0..10000
  --host <loopback>              localhost, 127.x.x.x, or ::1 (default: 127.0.0.1)
  --port <number>                Listening port (default: 0, random)
  --help                         Print this usage

Evaluator handshake:
  1. Start this command and parse the single JSON line from stdout.
  2. Open record.url or record.architectureUrl with Playwright.
  3. GET record.diagnosticsUrl for bounded invariants; POST record.recoveryUrl then use Story Board Refresh for recovery.
  4. Collect browser evidence. POST record.closeUrl, or send SIGINT/SIGTERM, and wait for process exit.
No Playwright installation, Pi process, TUI, credentials, or non-loopback listener is created by this command.`;

async function main(): Promise<void> {
	const { values } = parseArgs({ options: { "repository-root": { type: "string" }, "architecture-artifact": { type: "string" }, "discovery-delay-ms": { type: "string" }, host: { type: "string" }, port: { type: "string" }, help: { type: "boolean" } }, strict: true });
	if (values.help) { process.stdout.write(`${usage}\n`); return; }
	let fixture: AssistedFixtureRepository | undefined;
	if (!values["repository-root"]) fixture = await createAssistedFixtureRepository();
	const repositoryRoot = values["repository-root"] ?? fixture!.repositoryRoot;
	const architectureArtifactPath = values["architecture-artifact"] ?? fixture?.architectureArtifactPath;
	const launch = await launchAssistedVisualCompanion({ repositoryRoot, ...(architectureArtifactPath ? { architectureArtifactPath } : {}), discoveryDelayMs: Number(values["discovery-delay-ms"] ?? 0), ...(values.host ? { host: values.host } : {}), port: values.port === undefined ? 0 : Number(values.port) });
	let shutdownPromise: Promise<void> | undefined;
	const shutdown = () => shutdownPromise ??= (async () => { process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal); await launch.close(); await fixture?.cleanup(); })();
	const onSignal = () => { void shutdown().then(() => { process.exitCode = 0; }); };
	process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
	process.stdout.write(`${JSON.stringify({ type: "visual-companion-assisted-start", schemaVersion: 1, pid: process.pid, host: launch.host, port: launch.port, url: launch.url, architectureUrl: launch.architectureUrl, diagnosticsUrl: launch.diagnosticsUrl, ...(launch.recoveryUrl ? { recoveryUrl: launch.recoveryUrl } : {}), closeUrl: launch.closeUrl })}\n`);
	// The backend listener is deliberately unref'ed for production Pi lifecycle. Keep this standalone command alive explicitly.
	const keepAlive = setInterval(() => {}, 60_000);
	try { while (launch.diagnostics().state !== "closed") await new Promise((done) => setTimeout(done, 50)); }
	finally { clearInterval(keepAlive); await shutdown(); }
}

main().catch((error) => { process.stderr.write(`${JSON.stringify({ type: "visual-companion-assisted-error", message: error instanceof Error ? error.message : String(error) })}\n`); process.exitCode = 1; });
