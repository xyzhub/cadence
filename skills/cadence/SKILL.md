---
name: cadence
description: Run a Cadence orchestration loop — a stateless orchestrator over a durable ledger with bounded context, gate signals, and context-firewalled fan-out. Use for long autonomous /loop sessions or any multi-pass engineering work where the context window would otherwise bloat. Triggers on "run the loop", "cadence tick", "continue the loop", or when starting multi-pass autonomous work in a repo that has a .cadence/ directory.
---

# Cadence

A portable loop for long autonomous work: the orchestrator stays a **stateless controller** over
`.cadence/loop-state.json`, so its context is bounded by construction instead of bloating then being
compacted. Full design in `${CLAUDE_PLUGIN_ROOT}/README.md`; protocols in `${CLAUDE_PLUGIN_ROOT}/protocols/`.

## Easiest path — slash commands
```
/cadence init "<objective>"   # onboard this repo (new OR existing), then offer to plan
/cadence plan                 # decompose the goal into a scored, gate-verifiable backlog
/cadence start                # run the autonomous loop until a pause condition
/cadence-tick                 # one pass     ·    /loop 10m /cadence-tick  → one pass per interval
/cadence-status               # read-only ledger digest + dashboard
```
`/cadence init --dry-run` previews adoption (detects gates, writes nothing). `/cadence` with no verb
prints full usage. The commands are thin wrappers over the `lib/` CLI below — that CLI is the
contract; the commands just save you the typing.

## First time in a repo (what `/cadence init` runs)
```
node "${CLAUDE_PLUGIN_ROOT}/lib/adopt.mjs" --goal "<objective>"   # detects gates, writes .cadence/, wires AGENTS.md
node .cadence/lib/doctor.mjs                                       # verify wiring
```
After adopt, every later tick runs from the repo-local `.cadence/lib/` copy; only `adopt` and the
reference docs (README, `protocols/`, `templates/`) live in the plugin at `${CLAUDE_PLUGIN_ROOT}`.

## Each tick (one pass — what `/cadence-tick` runs)
1. `node .cadence/lib/tick.mjs` — digest + next item + relevant gate signals (the bounded inputs).
2. Take the highest-value pending item (address its `lastError` if retrying). If it's `plan-backlog` or the queue is thin, PLAN instead (`/cadence plan`).
3. Act. For wide/risky work, fan out (see `${CLAUDE_PLUGIN_ROOT}/templates/workflows/`): cheap tier for reads, strong tier for synthesis/verify; subagents return distilled, pointer-only results. **Never read corpora or raw logs into your own context.**
4. `node .cadence/lib/run-gate.mjs --auto` — a SIGNAL, not logs. `reason:"gate"` = code; `reason:"error"` = config.
5. Verify by execution; review your own diff via a firewalled reviewer before commit.
6. Close: green → `ledger.mjs done <id> "<line>"` + commit only your files; red → `ledger.mjs fail <id> --error "..."`; empty diff → `ledger.mjs decide ...`.
7. `ledger.mjs fact` durable knowledge; `ledger.mjs decide` the rationale. End the tick.

## Pause, don't churn
Stop and hand back when the top pending score is below threshold, all remaining items are
`blockedOnOwner`, or two ticks produced no high-value change.

## Ledger verbs
`show · next · add <id> <score> "<desc>" · done <id> "<line>" · fail <id> --error "..." · block/unblock <id> · gate <id> pass|fail · fact "..." · decide "..." "why" · validate`

## Load a protocol only when needed
Read `${CLAUDE_PLUGIN_ROOT}/protocols/NN-*.md` on demand — reference, not per-tick:
`00` stateless model · `01` context firewall · `02` ledger · `03` gate signals · `04` fan-out+tiering ·
`05` verification · `06` parallel worktrees (opt-in) · `07` retrieval-first · `08` lifecycle · `09` context budget (the 30% rule) · `10` planning.
