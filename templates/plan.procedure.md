<!-- Canonical Cadence planning-tick procedure (Protocol 10). Shared source of truth,
     @-embedded by commands/cadence.md (the `init`/`plan` verbs). Edit here, not in the
     commands, so the procedure stays DRY. -->

# Cadence — planning tick (decompose a goal into a backlog) [Protocol 10]

You are shaping the ledger's `pending` queue so that every later tick executes from the digest **+
one brief** and **never explores**. Run this when the next item is `plan-backlog`, when the queue is
empty/thin, or when the user runs `/cadence plan`. Planning is itself **one tick** — bounded like any
other. Don't hold a big upfront plan in your window; write it into the ledger + briefs and discard.

**Preflight.** No `.cadence/`? Tell the user to run `/cadence init "<goal>"` first, and stop. Read the
current goal and state with `node .cadence/lib/ledger.mjs show`.

1. **Explore ONCE, retrieval-first [P07].** Build just enough of a map to decompose the goal. Prefer a
   code graph when present (`.codegraph/` → `codegraph explore` / `codegraph node`, or the codegraph
   MCP tools) over grep + whole-file reads; fall back to `rg -n`. Delegate any high-volume reading to
   subagents that return **distilled, pointer-only** results. Build a large-files table (file → line
   count) so execution ticks do ranged reads, never whole-file reads.

2. **Write per-item briefs** to `.cadence/plan/<goal>.briefs.md`, one section per item. Each brief
   pre-resolves the **exact** reads (files + line regions + anchors), the do/verify steps, a read
   budget, and a one-line acceptance. Briefs live **outside** the ledger (which stays a bounded
   digest); the ledger holds only the index + a pointer into the brief.

3. **Add each item** — small, scored, gate-verifiable, pre-resolved:
   ```
   node .cadence/lib/ledger.mjs add <id> <score> "<desc>" \
     --gate <gateId> --accept "<one-line criterion>" --brief plan/<goal>.briefs.md#<id>
   ```
   - **Gate-verifiable** — name the failable check that proves it done. No gate yet? Split the item,
     or add the gate first.
   - **Budget-sized** — fits one tick / one subagent window. If a brief's reads exceed budget, split
     (note the split).
   - **Scored** — `score = value ÷ effort`; a prerequisite scores **higher** than what it unblocks.
     There is no `dependsOn` field — ordering is expressed through scores + `block`/`unblock`.

4. **Close planning.** If you picked up the seeded item, mark it done:
   `node .cadence/lib/ledger.mjs done plan-backlog "decomposed <goal> into N items"`. Re-plan
   continuously: any later tick may `add` a newly-discovered item, rescore, or `block` an owner
   question.

**Failable check.** A separate execution tick must be able to act on any item you wrote from the
digest + that one brief **without opening anything the brief didn't list**. If an executor would have
to explore, tighten the brief — don't widen the window.

**When to skip the ceremony.** For a handful of obvious items, just `node .cadence/lib/ledger.mjs add`
them and let the loop execute — don't ceremony-tax a small goal.
