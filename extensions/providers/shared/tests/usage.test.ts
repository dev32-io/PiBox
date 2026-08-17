import assert from "node:assert/strict";
import test from "node:test";
import { formatUsageSnapshot, normalizeWindows, readUsageStatus } from "../usage.js";

test("usage contract accepts variable windows and only valid percentages", () => {
 assert.equal(normalizeWindows([{ percent: 0 }, { percent: 100 }, { percent: 101 }]).length, 2);
 assert.equal(formatUsageSnapshot({ provider: "x", observedAt: 0, windows: [{ usedPercent: 70 }] }), "70%");
});
test("status parsing never exposes malformed or empty quota", () => {
 assert.equal(readUsageStatus(JSON.stringify({ provider: "ollama-cloud", windows: [] })), undefined);
 assert.equal(readUsageStatus("not-json"), undefined);
});
