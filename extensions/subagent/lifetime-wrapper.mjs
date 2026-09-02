#!/usr/bin/env node
import { spawn } from "node:child_process";

const separator = process.argv.indexOf("--", 2);
const childArgv = separator >= 0 ? process.argv.slice(separator + 1) : process.argv.slice(2);
const command = childArgv.shift();
if (!command) {
	process.stderr.write("lifetime-wrapper: missing child command\n");
	process.exit(2);
}

const graceValue = Number(process.env.PIBOX_LIFETIME_TERM_GRACE_MS ?? 1_000);
const termGraceMs = Number.isFinite(graceValue) && graceValue >= 0 ? graceValue : 1_000;
const grouped = process.platform !== "win32";
const child = spawn(command, childArgv, {
	detached: grouped,
	env: process.env,
	stdio: ["ignore", "inherit", "inherit"],
});

let terminating = false;
let escalationComplete = false;
let childClosed = false;
let childExitCode = 1;

function signalChild(signal) {
	if (!child.pid) return;
	try {
		if (grouped) process.kill(-child.pid, signal);
		else child.kill(signal);
	} catch (error) {
		if (error?.code !== "ESRCH") process.stderr.write(`lifetime-wrapper: ${String(error)}\n`);
	}
}

function finishIfSafe() {
	if (!childClosed) return;
	// During lease-loss teardown the process-group grace window, not direct-child
	// lifetime, is authoritative. A leader may exit on SIGTERM while descendants
	// remain in its group, so the wrapper stays alive through SIGKILL escalation.
	if (terminating && !escalationComplete) return;
	process.exit(childExitCode);
}

function terminate() {
	if (terminating) return;
	terminating = true;
	signalChild("SIGTERM");
	setTimeout(() => {
		signalChild("SIGKILL");
		escalationComplete = true;
		finishIfSafe();
	}, termGraceMs);
}

process.stdin.resume();
process.stdin.once("end", terminate);
process.stdin.once("error", terminate);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, terminate);

child.once("error", (error) => {
	process.stderr.write(`lifetime-wrapper: failed to start child: ${error.message}\n`);
	childExitCode = 1;
});
child.once("close", (code, signal) => {
	childClosed = true;
	childExitCode = code ?? (signal ? 128 : 1);
	finishIfSafe();
});
