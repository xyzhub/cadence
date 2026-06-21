# Cadence

**A portable orchestration loop for AI coding agents — a stateless orchestrator over durable external memory.**

Each *tick*, the orchestrator rebuilds a **bounded** working context from a state ledger + the one
artifact it needs, acts through context-firewalled subagents, gates the result on a parseable
**signal** (never raw logs), and writes conclusions back out. Context is bounded **by construction**
— it never bloats, so it never needs lossy "compaction." Think CPU over RAM, not a chat transcript.

Drops into **any** stack (JS, Python, Rust, Go, …) via a single config file.

> Name is provisional (`Cadence`); the design also shortlisted `Tick`. Rename freely — it's one string.

---

## The model in one breath

A normal agent is **stateful**: one ever-growing transcript that must eventually be summarized
(lossy → weakens judgment). Cadence makes the orchestrator a **stateless controller**: durable
state lives in `.cadence/loop-state.json` (lossless, external); each tick reconstructs only what it
needs and discards the window. Nothing accumulates, so nothing is lost.

```
TICK:  read ledger digest ──▶ pick highest-value pending item
         │
         ├─ delegate volume to subagents (they read corpora; return distilled JSON)   ← context firewall
         ├─ act (edit / implement)
         ├─ run only the relevant gates ──▶ SIGNAL {pass, firstError}                   ← never raw logs
         ├─ green → ledger done <id>   |   red → ledger fail <id> (re-opens with error) ← loop closes
         ├─ record verifiedFacts / decisions ; commit only files you wrote
         └─ update ledger ──▶ end tick (window discarded)
```

## Quick start (apply to any project)

```bash
# from your project root, pointing at the Cadence source:
node /path/to/cadence/lib/adopt.mjs --goal "your objective"
node .cadence/lib/doctor.mjs            # verify wiring + that gate commands resolve
node .cadence/lib/ledger.mjs show       # the per-tick digest
```

`adopt` detects your gates (package.json scripts / Makefile / pyproject / Cargo / go.mod), writes
`.cadence/cadence.config.json`, seeds the ledger, copies a **self-contained** core into `.cadence/lib/`,
and appends a contract block to your `AGENTS.md`. Edit the config to taste — it's the only file you own.

## What's core vs opt-in (right-sizing)

| Tier | Pieces | Use it when |
|---|---|---|
| **Core** (always) | `ledger.mjs` + `loop-state.schema.json`, `run-gate.mjs` + `gate-signal.schema.json`, `adopt`/`doctor` | Any multi-pass or long autonomous run. Works standalone, ~5 files, one config. |
| **Opt-in** | `relevance.mjs` (skip gates a diff can't affect) | The full gate suite is slow (> a couple minutes). |
| **Opt-in** | Fan-out workflows + agent prompts (`templates/`) | Work is parallelizable or needs adversarial verification. |
| **Opt-in (heavy)** | `parallel` worktrees | ≥2 genuinely independent substantial edits per pass. Per-worktree setup has real cost. |

## Cost of Cadence (be honest)

- **Installs:** ~5 core scripts + 4 schemas into `.cadence/`, plus one `cadence.config.json` you maintain.
- **You hand-write:** the gate commands + fail patterns for your stack (a few lines). `adopt` pre-fills common ones.
- **Runtime dep:** Node (for the core scripts). No npm install — zero third-party deps.
- **The protocol docs are reference-only** — load a protocol when you need it, not every tick.

## When NOT to use it

- A one-shot task that fits in a single pass — just do it; the loop is pure overhead.
- A project with no failable gate (nothing to verify against) — Cadence's spine is the gate signal.
- A throwaway script. The ledger + tick discipline earns its cost only across many passes.

## Layout

```
cadence/
  README.md            ← you are here
  AGENTS.md            ← how agents operate in a Cadence repo (the contract)
  protocols/           ← the 9 protocols (reference; load on demand)
  schemas/             ← ledger / gate-signal / adapter / subagent-result (JSON Schema)
  lib/                 ← ledger.mjs · run-gate.mjs · relevance.mjs · adopt.mjs · doctor.mjs · tick.mjs
  templates/           ← cadence.config example · loop-prompt · agent prompts · workflow templates
  skill/SKILL.md       ← the Claude Code skill entry
```

Read `protocols/00-stateless-orchestrator.md` next for the architecture, then `08-lifecycle.md` for the tick.
