#!/usr/bin/env node
import { connect } from "node:net";

const [socketPath, token] = process.argv.slice(2);
if (!socketPath || !token) process.exit(2);

const socket = connect(socketPath);
let input = "";
let closing = false;
let blocked = false;

function parse() {
	if (input.length > 128 * 1024) return socket.destroy();
	while (!blocked) {
		const end = input.indexOf("\n");
		if (end < 0) return;
		const line = input.slice(0, end); input = input.slice(end + 1);
		let frame;
		try { frame = JSON.parse(line); } catch { return socket.destroy(); }
		if (frame?.type === "text" && typeof frame.text === "string") {
			if (!process.stdout.write(frame.text)) {
				blocked = true;
				socket.pause();
			}
		} else if (frame?.type === "close" && !closing) {
			closing = true;
			process.stdout.write("", () => socket.end(`${JSON.stringify({ type: "drained" })}\n`));
		}
	}
}

socket.setEncoding("utf8");
socket.on("connect", () => socket.write(`${JSON.stringify({ type: "hello", token })}\n`));
socket.on("data", (chunk) => { input += chunk; parse(); });
process.stdout.on("drain", () => {
	blocked = false;
	parse();
	if (!blocked) socket.resume();
});
socket.on("error", () => process.exit(0));
socket.on("close", () => process.exit(0));
