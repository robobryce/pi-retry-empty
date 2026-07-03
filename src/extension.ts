/**
 * pi-retry-empty — retry empty AND transient-error model responses.
 *
 * Two failure modes silently kill a headless run (`pi -p` / `--stream`), because
 * Pi's agent loop ends the turn and the process exits with no next turn:
 *
 *  1. EMPTY response — no text, no tool call, zero output tokens, clean
 *     `stopReason: "stop"` with no error. Pi treats it as a normal end-of-turn,
 *     so the run just stops (e.g. a manager that read its skills, ran `mkdir`,
 *     then got a blank continuation and quit without launching any work).
 *
 *  2. TRANSIENT ERROR — an assistant turn with `stopReason: "error"` whose
 *     message is a retryable HTTP/transport failure (429, 500/502/503/504,
 *     rate limit, overloaded, connection/stream drops, timeouts, …). Pi has its
 *     own retry for these, but it can be bypassed in practice (observed: a
 *     bodyless `429 status code (no body)` on the manager's own turn ended the
 *     run with no retry and no backoff). This extension is a reliable backstop:
 *     it runs on `agent_end`, after Pi's own retry decision, so it catches the
 *     error regardless of why the built-in path was skipped.
 *
 * The remedy in both cases is the same and is standard across agent harnesses
 * (Codex, LiteLLM, …): retry a bounded number of times. On `agent_end`, if the
 * last assistant turn is empty or a transient error, re-trigger the turn (up to
 * `maxRetries`), letting the model try again from the same context.
 *
 * Deliberately simple: bounded retry with a short backoff, no fallback, no
 * model-switching. It never retries a turn that produced real output, never
 * retries a non-retryable/permanent error (auth, quota/billing, bad request),
 * and caps retries per run so it can't loop forever.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Max retries per run. Overridable via the --retry-empty flag. */
const DEFAULT_MAX_RETRIES = 3;
/** Base backoff between retries (ms); doubles each attempt. */
const BASE_DELAY_MS = 2000;

const FLAG = "retry-empty";

interface AssistantMessage {
	role: string;
	content?: Array<{ type: string; text?: string }>;
	stopReason?: string | null;
	errorMessage?: string | null;
	usage?: { totalTokens?: number; output?: number };
}

/**
 * True when a message is an assistant turn that produced nothing usable: no
 * tool call, no non-empty text, zero output tokens, and no error. This is the
 * empty-response signature.
 */
export function isEmptyAssistantTurn(msg: AssistantMessage | undefined): boolean {
	if (!msg || msg.role !== "assistant") return false;
	if (msg.errorMessage) return false; // errors are handled by isTransientErrorTurn
	if (msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== null) return false;

	const content = Array.isArray(msg.content) ? msg.content : [];
	const hasToolCall = content.some((c) => c.type === "toolCall" || c.type === "tool_use");
	const hasText = content.some((c) => c.type === "text" && (c.text ?? "").trim().length > 0);
	if (hasToolCall || hasText) return false;

	const usage = msg.usage;
	return !usage || (usage.totalTokens ?? 0) === 0 || (usage.output ?? 0) === 0;
}

/**
 * Permanent errors that must NOT be retried (auth, quota/billing, bad request).
 * Mirrors Pi's own non-retryable provider-limit set plus common auth/4xx.
 */
function isPermanentError(err: string): boolean {
	return /GoUsageLimitError|FreeUsageLimitError|monthly usage limit|available balance|insufficient_quota|out of budget|quota exceeded|billing|invalid.?api.?key|unauthorized|authentication|permission denied|invalid.?request|400 |401 |403 |404 /i.test(
		err,
	);
}

/**
 * True when a message is an assistant turn that failed with a transient,
 * retryable error. Mirrors Pi's own retryable-error classification (429, 5xx,
 * rate limit, overloaded, connection/stream/transport failures, timeouts).
 */
export function isTransientErrorTurn(msg: AssistantMessage | undefined): boolean {
	if (!msg || msg.role !== "assistant") return false;
	if (msg.stopReason !== "error") return false;
	const err = msg.errorMessage ?? "";
	if (!err) return false;
	if (isPermanentError(err)) return false;
	return /overloaded|provider.?returned.?error|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?closed|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|stream ended before message_stop|http2 request did not get a response|timed? out|timeout|terminated|retry delay|status code/i.test(
		err,
	);
}

/** Reason a turn should be retried, or null. */
export function retryReason(msg: AssistantMessage | undefined): "empty" | "transient-error" | null {
	if (isTransientErrorTurn(msg)) return "transient-error";
	if (isEmptyAssistantTurn(msg)) return "empty";
	return null;
}

/** Last assistant message in a list, or undefined. */
export function lastAssistant(messages: AssistantMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return messages[i];
	}
	return undefined;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export default function registerRetryEmptyExtension(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG, {
		description: `Max times to retry an empty or transient-error model response per run (default ${DEFAULT_MAX_RETRIES}; 0 disables).`,
		type: "string",
		default: String(DEFAULT_MAX_RETRIES),
	});

	let maxRetries = DEFAULT_MAX_RETRIES;
	let retries = 0;

	pi.on("session_start", () => {
		const raw = pi.getFlag(FLAG);
		const n = typeof raw === "string" ? Number.parseInt(raw, 10) : Number(raw);
		maxRetries = Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_RETRIES;
		retries = 0;
	});

	pi.on("agent_end", async (event: { messages?: AssistantMessage[] }, _ctx: ExtensionContext) => {
		if (maxRetries <= 0) return;
		const last = lastAssistant(event.messages ?? []);
		const reason = retryReason(last);
		if (!reason) {
			// A real (non-empty, non-error) turn resets the budget for later stalls.
			retries = 0;
			return;
		}
		if (retries >= maxRetries) return;
		retries += 1;

		// Short exponential backoff before retrying — a transient error (esp. a
		// 429) usually clears after a brief wait. Empty responses retry quickly.
		const delayMs = reason === "transient-error" ? BASE_DELAY_MS * 2 ** (retries - 1) : 0;
		if (delayMs > 0) await sleep(delayMs);

		// Re-trigger the turn from the same context via a custom follow-up (not a
		// user message), so the transcript stays clean while the model retries.
		const nudge =
			reason === "empty"
				? "The previous response was empty. Continue with the task."
				: "The previous request failed with a transient error. Retry and continue with the task.";
		try {
			await pi.sendMessage(
				{ customType: "retry-empty", content: nudge, display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// If re-triggering fails, do nothing — better a stopped run than a crash.
		}
	});
}
