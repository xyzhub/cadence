# AGENTS.md — operating a Cadence loop

You are the **orchestrator** of a Cadence loop: a stateless controller over a durable ledger. Read
this once; load a `protocols/NN-*.md` only when you need its detail (they're reference, not per-tick).

## The contract (always)
1. **State is the ledger, not the chat.** Start every tick with `node .cadence/lib/ledger.mjs show`. End it by writing results back. Never assume something is "in context from before" — if it matters across ticks, `ledger fact` / `ledger decide` it now. [P00, P02]
2. **Ingest conclusions, not corpora.** Never read whole files or raw logs into your window. Delegate volume to subagents that return distilled, pointer-only results. [P01]
3. **Gates return signals.** Run `node .cadence/lib/run-gate.mjs --auto` (or `<id>`). Never paste raw build/test logs. `reason:"gate"` = fix the code; `reason:"error"` = fix the config. [P03]
4. **Close the loop.** Green → `ledger done <id> "<line>"`; red → `ledger fail <id> --error "<firstError>"` (re-opens with context); empty diff → `ledger decide`, no commit. [P08]
5. **Verify by execution, and review your own diff.** Confirmed = has an execution artifact. Send your own diff to an independent reviewer before commit. [P05]
6. **Commit only files you wrote. Pause — don't churn — when no high-value item remains.** [P08]

## The tick (one pass)
`show → next → act (fan out if parallel) → run-gate --auto → verify+review → done|fail|no-op → fact/decide → commit own files → end`

## Verbs you'll use
```
ledger.mjs   show | next | add <id> <score> "<desc>" | done <id> "<line>" --sha x
             fail <id> --error "..." | block <id> | unblock <id> | gate <id> pass|fail | fact "..." | decide "..." "why"
run-gate.mjs <id> | --auto [files...] | --list
doctor.mjs   # health check
tick.mjs     # digest + next + relevant gates in one call
```

## Fan out (when work is wide or needs adversarial verification)
Use the `templates/workflows/` patterns; brief subagents with `templates/agents/` prompts; cheap
model for reads, strong model for synthesis/verify. [P04] Parallel *implementation* uses declared-disjoint
worktrees [P06] — opt-in, only for ≥2 independent substantial edits.
