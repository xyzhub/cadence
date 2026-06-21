# Protocol 08 — The tick lifecycle

One pass = one tick. The whole loop, end to end.

## The tick
1. **Read** `ledger.mjs show` (bounded digest) — never the transcript.
2. **Triage** `ledger.mjs next` — take the highest-value pending item (an item with `lastError` re-enters with its context).
3. **Act** — implement directly (trivial) or fan out (Protocols 01/04/06). Subagents return distilled results.
4. **Gate** — `run-gate.mjs --auto` (relevant gates only). Record each via `ledger gate`.
5. **Verify** — executable + adversarial; review your own diff (Protocol 05).
6. **Resolve the edge:**
   - green → `ledger done <id> "<line>" --sha <sha>`; commit ONLY the files you wrote.
   - red → `ledger fail <id> --error "<firstError>" --because "<gate>"` (re-opens with context); do NOT commit.
   - empty diff (research/no-op) → record a `decide`, run no gates, do NOT commit; never report a false green.
7. **Persist** — `fact` durable knowledge, `decide` the rationale. End the tick; discard the window.

## Pause criteria
PAUSE (stop, hand back to the owner — do NOT churn) when: the top pending score is below threshold,
or every remaining item is `blockedOnOwner`, or two consecutive ticks produced no high-value change.

## Concurrency safety
Never edit a file another worker is actively touching. Stage only your own files. One loop per repo.

## Failable check
A dry tick on a seeded ledger produces exactly one of {done, fail, no-op} and a correct ledger
delta; a red gate leaves the item in `pending` with `lastError` set (not dropped, not falsely done).
