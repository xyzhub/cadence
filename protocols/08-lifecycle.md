# Protocol 08 — The tick lifecycle

One pass = one tick. The whole loop, end to end.

## The tick
0. **Resume-check** — run `ledger.mjs tick` (or `tick.mjs`): if a prior tick was interrupted (a crash left `inFlight` set), it auto-reconciles — a red gate auto-reopens the item with context; a green gate surfaces a `reconcile --done | --retry` choice. Then it prints the digest.
1. **Read** the digest — never the transcript.
2. **Triage** `ledger.mjs next` — take the highest-value pending item (an item with `lastError` re-enters with its context).
3. **Declare intent** — `ledger.mjs begin <id> [--step act]` BEFORE any side effect. This is the write-ahead intent journal: if you crash now, the next tick's resume-check finds it.
4. **Act** — implement directly (trivial) or fan out (Protocols 01/04/06). Subagents return distilled results.
5. **Gate** — `run-gate.mjs --auto` (relevant gates only). Record each via `ledger gate`.
6. **Verify** — executable + adversarial; review your own diff (Protocol 05).
7. **Resolve the edge** (this clears `inFlight`):
   - green → `ledger done <id> "<line>" --sha <sha>`; commit ONLY the files you wrote.
   - red → `ledger fail <id> --error "<firstError>" --because "<gate>"` (re-opens with context); do NOT commit.
   - empty diff (research/no-op) → `ledger reconcile --retry` or a `decide`, run no gates, do NOT commit; never report a false green.
8. **Persist** — `fact` durable knowledge, `decide` the rationale. End the tick; discard the window.

## Crash recovery (better than a checkpoint)
State is durable by construction: every ledger write is atomic (tmp + rename) and per-mutation, so a
`kill -9` can never corrupt or lose committed state — recovery is just "read the ledger and continue"
(startup and recovery are the same path). The **intent journal** (`begin` → `inFlight`, cleared on
`done`/`fail`) closes the one gap a bare ledger has: a crash *between* a side effect and its ledger
write. On resume, step 0 detects `inFlight` and reconciles — red gate ⇒ auto-retry (safe, automatic);
green gate ⇒ surfaced for confirmation (never auto-completed, to avoid a false "done").

## Single-writer lock
At session start: `ledger.mjs lock --owner <id>`; at end: `ledger.mjs unlock`. A second loop on the same
repo is refused. A crashed session's lock is reclaimed automatically when stale (older than `--ttl`, or
its `--pid` supervisor is dead) — or `lock --force`.

## Pause criteria
PAUSE (stop, hand back to the owner — do NOT churn) when: the top pending score is below threshold,
or every remaining item is `blockedOnOwner`, or two consecutive ticks produced no high-value change.

## Concurrency safety
Never edit a file another worker is actively touching. Stage only your own files. One loop per repo.

## Failable check
A dry tick on a seeded ledger produces exactly one of {done, fail, no-op} and a correct ledger
delta; a red gate leaves the item in `pending` with `lastError` set (not dropped, not falsely done).
