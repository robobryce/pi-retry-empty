/**
 * pi-retry-empty — retry empty model responses.
 *
 * Some providers/models occasionally return an empty assistant turn: no text,
 * no tool call, zero output tokens, and `stopReason: "stop"` with no error. Pi's
 * agent loop treats that as a normal end-of-turn, so the run just stops — often
 * silently abandoning the task (e.g. a manager that read its skill files, ran
 * `mkdir`, then got a blank continuation and quit without launching any work).
 *
 * This is a transient content-level failure, and the standard remedy across
 * agent harnesses (Codex, LiteLLM, etc.) is to retry it a bounded number of
 * times. That's all this extension does: on `agent_end`, if the last assistant
 * turn is empty, it re-triggers the turn (up to `maxRetries`), letting the model
 * try again from the same context.
 *
 * Deliberately simple: no backoff, no fallback, no model-switching — just a
 * bounded retry. It never retries a turn that produced any real output, and it
 * caps retries per run so it can't loop forever.
 */

import type { AgentEndEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Max empty-response retries per run. Overridable via the --retry-empty flag. */
const DEFAULT_MAX_RETRIES = 3;

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
 * tool call, no non-empty text, and zero output tokens, and it wasn't an error
 * (errors have their own retry path in Pi). This is the empty-response signature.
 */
export function isEmptyAssistantTurn(msg: AssistantMessage | undefined): boolean {
	if (!msg || msg.role !== "assistant") return false;
	// Errors are handled by Pi's own retry; only touch clean/no-error stops.
	if (msg.errorMessage) return false;
	if (msg.stopReason && msg.stopReason !== "stop" && msg.stopReason !== null) return false;

	const content = Array.isArray(msg.content) ? msg.content : [];
	const hasToolCall = content.some((c) => c.type === "toolCall" || c.type === "tool_use");
	const hasText = content.some((c) => c.type === "text" && (c.text ?? "").trim().length > 0);
	if (hasToolCall || hasText) return false;

	const usage = msg.usage;
	const zeroTokens = !usage || (usage.totalTokens ?? 0) === 0 || (usage.output ?? 0) === 0;
	return zeroTokens;
}

/** Last assistant message in a list, or undefined. */
export function lastAssistant(messages: AssistantMessage[]): AssistantMessage | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i]?.role === "assistant") return messages[i];
	}
	return undefined;
}

export default function registerRetryEmptyExtension(pi: ExtensionAPI): void {
	pi.registerFlag(FLAG, {
		description: `Max times to retry an empty model response per run (default ${DEFAULT_MAX_RETRIES}; 0 disables).`,
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

	pi.on("agent_end", async (event: AgentEndEvent) => {
		if (maxRetries <= 0) return;
		const last = lastAssistant(event.messages as AssistantMessage[]);
		if (!isEmptyAssistantTurn(last)) {
			// A real (non-empty) turn resets the budget for later independent stalls.
			retries = 0;
			return;
		}
		if (retries >= maxRetries) return;
		retries += 1;

		// Re-trigger the turn from the same context. A custom follow-up message
		// (not a user message) keeps the transcript clean while nudging the model
		// to produce the response it dropped.
		try {
			await pi.sendMessage(
				{
					customType: "retry-empty",
					content: "The previous response was empty. Continue with the task.",
					display: false,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} catch {
			// If re-triggering fails, do nothing — better a stopped run than a crash.
		}
	});
}
