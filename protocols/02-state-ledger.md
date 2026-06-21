# Protocol 02 — The state ledger

`.cadence/loop-state.json` is durable external memory. Schema: `schemas/loop-state.schema.json`.
Driver: `lib/ledger.mjs` (the only writer).

## Fields
- `currentGoal`, `tick` — objective + monotonic pass counter.
- `pending[]` — value-scored queue; items carry `lastError` when a tick on them failed (the failure loop).
- `done[]` — `{id, line, sha?, tick}`.
- `blockedOnOwner[]` — items awaiting a human decision; `unblock` returns them to `pending`.
- `verifiedFacts[]` — a paged **index** of lossless cross-tick knowledge (one-liners + pointers); older entries page to `facts.jsonl`.
- `recentDecisions[]` — FIFO-capped rolling judgment (the one deliberate bend in statelessness).
- `gates{}` — last signal per gate id; written ONLY via `ledger gate` (single writer).

## Rules
- MUST go through `ledger.mjs` verbs (`show/next/add/done/fail/block/unblock/gate/fact/decide`) — no hand-edits.
- MUST record durable knowledge as a `fact` and notable choices as a `decide` the moment they form.
- `verifiedFacts` is an index — keep evidence on disk addressable by `pointer`, not inline.

## Failable check
`ledger.mjs validate` exits non-zero on a malformed ledger (fails closed). Round-trip a
block→unblock and a fail→retry; confirm the item carries its prior context.

## Anti-pattern it prevents
Prose state threaded through an ever-growing prompt — heavy, drift-prone, and unbounded.
