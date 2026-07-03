// Tests for pi-retry-empty: the empty-turn detector and the bounded retry loop.
import assert from "node:assert/strict";
import { test } from "node:test";
import registerRetryEmptyExtension, {
	isEmptyAssistantTurn,
	lastAssistant,
} from "../src/extension.ts";

// ── detection ────────────────────────────────────────────────────────────────

test("detects an empty assistant turn (no content, zero tokens, clean stop)", () => {
	assert.equal(
		isEmptyAssistantTurn({ role: "assistant", content: [], stopReason: "stop", usage: { totalTokens: 0, output: 0 } }),
		true,
	);
	// whitespace-only text still counts as empty
	assert.equal(
		isEmptyAssistantTurn({ role: "assistant", content: [{ type: "text", text: "  \n" }], stopReason: "stop", usage: { totalTokens: 0 } }),
		true,
	);
	// null stopReason (some providers) also counts
	assert.equal(
		isEmptyAssistantTurn({ role: "assistant", content: [], stopReason: null, usage: { output: 0 } }),
		true,
	);
});

test("does NOT flag a real turn", () => {
	// has text + tokens
	assert.equal(
		isEmptyAssistantTurn({ role: "assistant", content: [{ type: "text", text: "hi" }], stopReason: "stop", usage: { totalTokens: 5, output: 5 } }),
		false,
	);
	// has a tool call
	assert.equal(
		isEmptyAssistantTurn({ role: "assistant", content: [{ type: "toolCall" }], stopReason: "toolUse", usage: { totalTokens: 9, output: 9 } }),
		false,
	);
	// tool-use stop reason is not our case
	assert.equal(
		isEmptyAssistantTurn({ role: "assistant", content: [], stopReason: "toolUse" }),
		false,
	);
});

test("does NOT flag an error turn (Pi retries those itself)", () => {
	assert.equal(
		isEmptyAssistantTurn({ role: "assistant", content: [], stopReason: "error", errorMessage: "boom", usage: { totalTokens: 0 } }),
		false,
	);
});

test("non-assistant / missing messages are not empty turns", () => {
	assert.equal(isEmptyAssistantTurn(undefined), false);
	assert.equal(isEmptyAssistantTurn({ role: "user", content: [] }), false);
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
const realMsg = { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop", usage: { totalTokens: 4, output: 4 } };

test("retries an empty turn up to maxRetries, then stops", async () => {
	const { pi, handlers, sends } = mockPi("3");
	registerRetryEmptyExtension(pi);
	handlers.session_start();

	// Simulate 5 consecutive empty turns; only 3 retries should fire.
	for (let i = 0; i < 5; i++) await handlers.agent_end({ messages: [emptyMsg] });
	assert.equal(sends.length, 3, "capped at maxRetries=3");
	assert.equal(sends[0].opts.triggerTurn, true);
	assert.equal(sends[0].opts.deliverAs, "followUp");
	assert.equal(sends[0].msg.display, false);
});

test("does not retry a real turn", async () => {
	const { pi, handlers, sends } = mockPi("3");
	registerRetryEmptyExtension(pi);
	handlers.session_start();
	await handlers.agent_end({ messages: [realMsg] });
	assert.equal(sends.length, 0);
});

test("a real turn resets the retry budget", async () => {
	const { pi, handlers, sends } = mockPi("2");
	registerRetryEmptyExtension(pi);
	handlers.session_start();
	await handlers.agent_end({ messages: [emptyMsg] }); // retry 1
	await handlers.agent_end({ messages: [emptyMsg] }); // retry 2 (cap)
	await handlers.agent_end({ messages: [emptyMsg] }); // no retry (budget spent)
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
	assert.equal(sends.length, 0);
});
