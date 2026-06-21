# Protocol 00 — Stateless orchestrator over durable memory

The spine. The orchestrator is a **controller**, not a stateful agent. It does not accumulate a
transcript; it reconstructs a minimal working context each tick from the ledger and discards it.

## Rules
- MUST treat `.cadence/loop-state.json` as the source of truth — NOT the chat history.
- MUST begin every tick with `ledger.mjs show` (the bounded digest) and end it by writing results back.
- MUST keep the per-tick working set **constant-sized** regardless of how many ticks/passes have run.
- NEVER rely on something being "in context from earlier." If it matters across ticks, write it to the ledger (`fact` / `decide`) the moment it forms.
- NEVER summarize-to-shrink. Bounded-by-construction beats lossy compaction: don't grow the window, then there's nothing to compress.

## Failable check
Start a fresh tick that reads ONLY `ledger.mjs show` (no transcript): it must name the correct next
item, list every owner-blocker, and recall the key `verifiedFacts`. If it redoes a `done` item or
drops a blocker, the ledger is insufficient — enrich it, don't widen the window.

## Anti-pattern it prevents
The transcript-bloat death spiral: window grows → quality drops (lost-in-the-middle) → forced lossy
compaction → judgment silently degrades.
