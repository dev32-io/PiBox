import assert from "node:assert/strict";
import test from "node:test";
import { fetchCodexUsage, normalizeCodexUsage } from "../index.js";

test("normalizes zero, one, and multiple variable Codex windows", () => {
	assert.deepEqual(normalizeCodexUsage({ windows: [] }), []);
	assert.deepEqual(normalizeCodexUsage({ rate_limits: [{ used_percent: 12, reset_at: 1_700_000_000 }, { usedPercent: 80, resetAt: 1_700_003_600 }] }), [
		{ usedPercent: 12, resetAt: 1_700_000_000_000 }, { usedPercent: 80, resetAt: 1_700_003_600_000 },
	]);
	assert.deepEqual(normalizeCodexUsage({ rate_limit: {
		primary_window: { used_percent: 92, limit_window_seconds: 604_800, reset_at: 1_800_000_000 },
		secondary_window: null,
	} }), [{ usedPercent: 92, durationMs: 604_800_000, resetAt: 1_800_000_000_000 }]);
});

test("fetches usage with ephemeral OAuth and account headers", async () => {
	let authorization = "";
	let account = "";
	const windows = await fetchCodexUsage({ apiKey: "oauth-secret", accountId: "account-1" }, (async (_input, init) => {
		const headers = init?.headers as Record<string, string>;
		authorization = headers.Authorization ?? "";
		account = headers["ChatGPT-Account-Id"] ?? "";
		return Response.json({ rate_limit: { primary_window: { used_percent: 92, reset_at: 1_800_000_000 }, secondary_window: null } });
	}) as typeof fetch);
	assert.equal(authorization, "Bearer oauth-secret");
	assert.equal(account, "account-1");
	assert.deepEqual(windows, [{ usedPercent: 92, resetAt: 1_800_000_000_000 }]);
});

test("uses token account when registry omits headers, preserving explicit account overrides", async () => {
	const apiKey = `header.${Buffer.from(JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: "token-account" },
	})).toString("base64url")}.signature`;
	for (const accountId of [undefined, "explicit-account"]) {
		const windows = await fetchCodexUsage({ apiKey, ...(accountId ? { accountId } : {}) }, (async (_input, init) => {
			const headers = new Headers(init?.headers);
			assert.equal(headers.get("ChatGPT-Account-Id"), accountId ?? "token-account");
			return Response.json({ rate_limit: {
				primary_window: { used_percent: headers.has("ChatGPT-Account-Id") ? 40 : 81, limit_window_seconds: 604_800 },
				secondary_window: null,
			} });
		}) as typeof fetch);
		assert.deepEqual(windows, [{ usedPercent: 40, durationMs: 604_800_000 }]);
	}
});

test("handles malformed or missing token account claims without fabricating headers", async () => {
	for (const payload of [undefined, "not-json", "null", "{}", JSON.stringify({
		"https://api.openai.com/auth": { chatgpt_account_id: 123 },
	})]) {
		const apiKey = payload === undefined ? "opaque-token" : `header.${Buffer.from(payload).toString("base64url")}.signature`;
		let headers: Headers | undefined;
		await fetchCodexUsage({ apiKey }, (async (_input, init) => {
			headers = new Headers(init?.headers);
			return Response.json({});
		}) as typeof fetch);
		assert.ok(headers);
		assert.equal(headers.has("ChatGPT-Account-Id"), false);
	}
});

test("rejects incomplete or fabricated quota data", () => {
	assert.deepEqual(normalizeCodexUsage({ windows: [{ used_percent: 101 }, { used_percent: -1 }, { reset_at: 123 }] }), []);
});
