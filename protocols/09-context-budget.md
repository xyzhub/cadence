# Protocol 09 — Context budget (the 30% target)

Keep every subagent working in the high-attention **first ~30% of its window**. Past it, recall
degrades ("lost in the middle" / context rot), so we don't go there on purpose. Helper:
`lib/context-budget.mjs`. Knob: the `context` block in `cadence.config.json` (`subagentWindowFraction`,
default `0.30`).

## What is actually enforced (and what isn't — read this)
You cannot truncate a model mid-run, so "30%" is achieved by controlling **inputs and scope**, not by a
runtime cap. Be precise about the three levers:

1. **Cap the INPUT — HARD, code-checked.** Before spawning, the brief + handed-in data must fit the
   input cap: `node .cadence/lib/context-budget.mjs fits <model> <paths|->` (also reads a composed
   prompt on **stdin**: `printf '%s' "$brief" | … fits <model> -`). Exit `0` fits · `1` too big
   (decompose) · `2` error/unreadable or `onExceed:abort`. It **fails closed**: a missing/unreadable
   path or unseeable input never returns "fits."
2. **Decompose oversized work — orchestrator-by-hand.** If a unit won't fit, the orchestrator shards it
   into subtasks that each fit, then fans out. There is **no auto-splitter** — `onExceed` only sets the
   `fits` exit semantics (`split`→1, `abort`→2); acting on it is the orchestrator's job.
3. **Brief the budget + self-report — SOFT/advisory.** Each subagent is told its budget and instructed
   to read narrowly, return early, and set `budget.needsDecomposition` (in `subagent-result.schema.json`)
   instead of overrunning. Nothing in code reads that flag — it's a signal for the orchestrator.

**Residual gap (disclosed):** the input cap bounds only the *input*. An agent that passes `fits` can
still read widely with its own tools at runtime and exceed the 30% budget — the input cap leaves
headroom (via `inputReserveFraction`, default 0.5) but does not *enforce* it. The only backstops are
**tight task scope** and the **soft self-report**. So the honest promise is: "we cap the input and scope
the task to keep the agent in its best region," not "the agent is hard-bounded to 30%."

## The numbers
`budgetTokens = window × fraction` (default `200000 × 0.30 = 60000`); `inputCapTokens = budget ×
inputReserveFraction` (default `× 0.5 = 30000`). Tokens are estimated from **UTF-8 bytes** (~3–4
bytes/token across English/code/CJK — more script-stable than chars, but still approximate; it can
under-count dense code/JSON and CJK, so lower `bytesPerToken` for CJK-heavy repos). The **30% default is
a tunable heuristic, not a hard cliff** — effective-attention decay varies by model; tune
`subagentWindowFraction` (and the per-model `models{}` window) per project. The orchestrator itself is
already bounded by construction (Protocol 00) and needs no budget.

## Failable check
`context-budget.mjs fits <model> <bigfile>` exits non-zero when the input exceeds the cap; a
missing/unreadable path exits `2` (never "fits"); the same content via file vs stdin yields the same
estimate. `budget <model>` reports `budgetTokens = window × fraction` and warns on an unknown model.

## Anti-pattern it prevents
Stuffing a subagent's window "because it all fits" — trading the model's best region for a full-but-dull
one. (It does **not**, by itself, stop an agent from over-reading at runtime — scope the task for that.)
