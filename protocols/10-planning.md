# Protocol 10 — Planning (backlog shaping)

Planning is how the ledger's `pending` queue gets created and kept well-formed. The loop (P08) is
fully specified from *pick-next-item* forward; this is the front half — turning a goal into a backlog
where **every item is small, scored, gate-verifiable, and pre-resolved so the executing tick never
explores.** The ledger IS the plan; planning is just the work of shaping it.

## Planning is the first tick (and a little of every tick)
`adopt --goal "X"` seeds ONE high-score item, `plan-backlog`. The first tick picks it up and runs
this protocol: explore the codebase ONCE (retrieval-first [P07]), then write the backlog. From the
next tick on, the loop executes. Planning is **not a separate stateful phase** — it is a tick,
bounded like any other, recorded in the ledger. Re-plan continuously: any later tick may `add` a
newly-discovered item, rescore, or `block` an owner question. Never hold a big upfront plan in your
window.

## A well-formed item
- **Gate-verifiable** — name the gate that proves it done (`add … --gate <id>`). If no failable check
  exists yet, the item isn't ready: split it, or add the gate first. [P03]
- **Budget-sized** — fits one tick / one subagent window. If a brief's reads exceed the budget, split
  the item (note the split). [P09]
- **Scored** — `score = value ÷ effort`; a prerequisite scores HIGHER than what it unblocks. The
  ledger has no `dependsOn` field by design — ordering is expressed through scores + `block`/`unblock`.
- **Pre-resolved by a brief** — the item carries `--brief <pointer>` into a brief that lists the
  EXACT reads (files + line regions + anchors), the do/verify steps, a read budget, and a one-line
  acceptance (`--accept`). The executing tick reads the digest + that one brief and nothing else —
  **it never explores.** This is what makes planning pay for itself.

## The brief artifact
Briefs are verbose, so they live OUTSIDE the ledger (which must stay a bounded digest): write them to
`.cadence/plan/<goal>.briefs.md`, one section per item, and point the ledger item at the section
(`--brief plan/<goal>.briefs.md#<id>`). The ledger holds the INDEX (id, score, gate, accept, brief
pointer); the tick loads only the one brief it needs — the same "ledger + the one artifact it needs"
discipline the whole framework runs on. Build a large-files table (file → line count) during planning
so execution ticks do grep-first ranged reads, never whole-file reads.

## When to skip
For a handful of obvious items, just `add` them and go — don't ceremony-tax a small goal. Plan
formally when the goal is large or its shape is uncertain. (Same honesty as the README's "when NOT to
use Cadence.")

## Failable check
From a seeded goal, the planning tick produces ≥1 scored `pending` item whose brief names exact reads
+ a gate + a one-line acceptance — and a SEPARATE execution tick can act on it from the digest + that
one brief WITHOUT opening anything the brief didn't list. If the executor has to explore, the brief
under-resolved its targets: tighten the plan, don't widen the window.

## Anti-pattern it prevents
The big-design-up-front plan held in the orchestrator's context — it bloats the window, goes stale,
and gets re-derived every tick. Plan into the ledger + briefs, then discard the window.

> Lineage: this is the "plan trio" pattern (master plan / per-session briefs / state ledger) with the
> ledger hardened into Cadence's atomic, validated, crash-safe `loop-state.json` and the verification
> step replaced by gate SIGNALS [P03]. Phase grouping (`--phase`) is reserved for a future optional
> independent phase-checkpoint review (a planned extension of [P05]); not required for the core loop.
