// Tests for pi-retry-empty: empty-turn + transient-error detection and the
// bounded retry loop.
import assert from "node:assert/strict";
import { test } from "node:test";
import registerRetryEmptyExtension, {
	isEmptyAssistantTurn,
	isTransientErrorTurn,
	retryReason,
	lastAssistant,
} from "../src/extension.ts";

// ── empty detection ──────────────────────────────────────────────────────────

test("detects an empty assistant turn (no content, zero tokens, clean stop)", () => {
	assert.equal(isEmptyAssistantTurn({ role: "assistant", content: [], stopReason: "stop", usage: { totalTokens: 0, output: 0 } }), true);
	assert.equal(isEmptyAssistantTurn({ role: "assistant", content: [{ type: "text", text: "  \n" }], stopReason: "stop", usage: { totalTokens: 0 } }), true);
	assert.equal(isEmptyAssistantTurn({ role: "assistant", content: [], stopReason: null, usage: { output: 0 } }), true);
});

test("does NOT flag a real turn as empty", () => {
	assert.equal(isEmptyAssistantTurn({ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", usage: { totalTokens: 5, output: 5 } }), false);
	assert.equal(isEmptyAssistantTurn({ role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse", usage: { totalTokens: 9, output: 9 } }), false);
	assert.equal(isEmptyAssistantTurn({ role: "assistant", content: [], stopReason: "toolUse" }), false);
});

// ── transient-error detection ────────────────────────────────────────────────

test("detects retryable transient errors (429, 5xx, rate limit, connection)", () => {
	for (const err of [
		"429 status code (no body)",
		"429 litellm.RateLimitError: RateLimitError",
		"503 Service Unavailable",
		"overloaded_error",
		"fetch failed",
		"stream ended before message_stop",
		"socket hang up",
		"connection reset before headers",
	]) {
		assert.equal(isTransientErrorTurn({ role: "assistant", stopReason: "error", errorMessage: err, content: [] }), true, `should retry: ${err}`);
	}
});

test("does NOT retry permanent errors (auth, quota, bad request)", () => {
	for (const err of [
		"401 Unauthorized",
		"invalid api key",
		"insufficient_quota",
		"Monthly usage limit reached",
		"available balance is too low",
		"400 invalid request",
	]) {
		assert.equal(isTransientErrorTurn({ role: "assistant", stopReason: "error", errorMessage: err, content: [] }), false, `should NOT retry: ${err}`);
	}
});

test("a non-error turn is not a transient error", () => {
	assert.equal(isTransientErrorTurn({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }), false);
	assert.equal(isTransientErrorTurn({ role: "assistant", stopReason: "error", errorMessage: "", content: [] }), false);
});

test("retryReason classifies correctly", () => {
	assert.equal(retryReason({ role: "assistant", stopReason: "error", errorMessage: "429 status code (no body)", content: [] }), "transient-error");
	assert.equal(retryReason({ role: "assistant", stopReason: "stop", content: [], usage: { totalTokens: 0 } }), "empty");
	assert.equal(retryReason({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }], usage: { totalTokens: 3 } }), null);
	assert.equal(retryReason({ role: "assistant", stopReason: "error", errorMessage: "401 Unauthorized", content: [] }), null);
});

test("lastAssistant finds the last assistant message", () => {
	assert.equal(lastAssistant([{ role: "user" }]), undefined);
	assert.equal(lastAssistant([{ role: "user" }, { role: "assistant", content: [] }]).role, "assistant");
});

// ── retry loop (mock pi) ─────────────────────────────────────────────────────

function mockPi(flagValue = "3") {
	const handlers = {};
	const sends = [];
	const pi = {
		registerFlag: () => {},
		getFlag: () => flagValue,
		on: (ev, h) => { handlers[ev] = h; },
		sendMessage: async (msg, opts) => { sends.push({ msg, opts }); },
	};
	return { pi, handlers, sends };
}

const emptyMsg = { role: "assistant", content: [], stopReason: "stop", usage: { totalTokens: 0, output: 0 } };
const errMsg = { role: "assistant", content: [], stopReason: "error", errorMessage: "429 status code (no body)", usage: { totalTokens: 0 } };
const permErr = { role: "assistant", content: [], stopReason: "error", errorMessage: "401 Unauthorized", usage: { totalTokens: 0 } };
const realMsg = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { totalTokens: 4, output: 4 } };

test("retries an empty turn up to maxRetries, then stops", async () => {
	const { pi, handlers, sends } = mockPi("3");
	registerRetryEmptyExtension(pi);
	handlers.session_start();
	for (let i = 0; i < 5; i++) await handlers.agent_end({ messages: [emptyMsg] });
	assert.equal(sends.length, 3);
	assert.equal(sends[0].opts.triggerTurn, true);
	assert.equal(sends[0].opts.deliverAs, "followUp");
	assert.equal(sends[0].msg.display, false);
});

test("retries a transient 429 error turn (with backoff)", async () => {
	const { pi, handlers, sends } = mockPi("2");
	registerRetryEmptyExtension(pi);
	handlers.session_start();
	const t0 = Date.now();
	await handlers.agent_end({ messages: [errMsg] });
	assert.equal(sends.length, 1, "429 error is retried");
	assert.ok(Date.now() - t0 >= 1900, "transient-error retry waited ~backoff (2s)");
	assert.match(sends[0].msg.content, /transient error/i);
});

test("does NOT retry a permanent error", async () => {
	const { pi, handlers, sends } = mockPi("3");
	registerRetryEmptyExtension(pi);
	handlers.session_start();
	await handlers.agent_end({ messages: [permErr] });
	assert.equal(sends.length, 0);
});

test("does not retry a real turn; a real turn resets the budget", async () => {
	const { pi, handlers, sends } = mockPi("2");
	registerRetryEmptyExtension(pi);
	handlers.session_start();
	await handlers.agent_end({ messages: [emptyMsg] }); // 1
	await handlers.agent_end({ messages: [emptyMsg] }); // 2 (cap)
	await handlers.agent_end({ messages: [emptyMsg] }); // none
	assert.equal(sends.length, 2);
	await handlers.agent_end({ messages: [realMsg] });  // resets
	await handlers.agent_end({ messages: [emptyMsg] }); // retry again
	assert.equal(sends.length, 3);
});

test("maxRetries=0 disables retrying entirely", async () => {
	const { pi, handlers, sends } = mockPi("0");
	registerRetryEmptyExtension(pi);
	handlers.session_start();
	await handlers.agent_end({ messages: [emptyMsg] });
	await handlers.agent_end({ messages: [errMsg] });
	assert.equal(sends.length, 0);
});
