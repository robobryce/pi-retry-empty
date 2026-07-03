# pi-retry-empty

A Pi extension that **retries empty model responses**.

Some providers/models occasionally return an empty assistant turn — no text, no
tool call, zero output tokens, and `stopReason: "stop"` with no error. Pi's agent
loop treats that as a normal end-of-turn, so the run just **stops**, often
silently abandoning the task (e.g. a manager that read its skill files, ran
`mkdir`, then got a blank continuation and quit without launching any work).

An empty response is a transient content-level failure. The standard remedy
across agent harnesses (Codex, LiteLLM, and others) is to retry it a bounded
number of times. That's all this extension does.

## Behavior

On `agent_end`, if the last assistant turn is **empty** (no tool call, no
non-empty text, zero output tokens, clean non-error `stop`), it re-triggers the
turn from the same context — up to `maxRetries` times per run.

- Never retries a turn that produced any real output.
- Never retries an **error** turn — Pi has its own retry path for those.
- Caps retries per run, so it can't loop forever. A real (non-empty) turn resets
  the budget for later independent stalls.

Deliberately simple: no backoff, no fallback, no model-switching — just a
bounded retry.

## Install

```bash
pi install git:github.com/robobryce/pi-retry-empty
```

## Configure

`--retry-empty <N>` sets the max retries per run (default **3**; `0` disables):

```bash
pi -p "..." --retry-empty 5
pi -p "..." --retry-empty 0     # disable
```

## Test

```bash
npm test
```
