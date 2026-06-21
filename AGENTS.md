# AGENTS.md — operating a Cadence loop

You are the **orchestrator** of a Cadence loop: a stateless controller over a durable ledger. Read
this once; load a `protocols/NN-*.md` only when you need its detail (they're reference, not per-tick).

## The contract (always)
1. **State is the ledger, not the chat.** Start every tick with `node .cadence/lib/ledger.mjs show`. End it by writing results back. Never assume something is "in context from before" — if it matters across ticks, `ledger fact` / `ledger decide` it now. [P00, P02]
2. **Ingest conclusions, not corpora.** Never read whole files or raw logs into your window. Delegate volume to subagents that return distilled, pointer-only results. [P01] For where/what/blast-radius lookups, prefer a code graph when present (`.codegraph/` → `codegraph explore`/`node`) over grep+read; `rg -n` fallback. [P07]
3. **Gates return signals.** Run `node .cadence/lib/run-gate.mjs --auto` (or `<id>`). Never paste raw build/test logs. `reason:"gate"` = fix the code; `reason:"error"` = fix the config. [P03]
4. **Close the loop.** Green → `ledger done <id> "<line>"`; red → `ledger fail <id> --error "<firstError>"` (re-opens with context); empty diff → `ledger decide`, no commit. [P08]
5. **Verify by execution, and review your own diff.** Confirmed = has an execution artifact. Send your own diff to an independent reviewer before commit. [P05]
6. **Commit only files you wrote. Pause — don't churn — when no high-value item remains.** [P08]

## The tick (one pass)
`tick (resume-check) → next → begin <id> → act (fan out if parallel) → run-gate --auto → verify+review → done|fail|no-op → fact/decide → commit own files → end`

`begin` writes a write-ahead intent journal BEFORE side effects. If you crash, the next `tick`
auto-reconciles (red gate → retry; green → confirm). State is atomic + durable, so resume is just
"read the ledger and continue" — no checkpoint to restore.

## Crash-safety & single-writer
- Start a session: `node .cadence/lib/ledger.mjs lock --owner <id>`; end: `unlock`. A second loop on the repo is refused; a crashed lock is reclaimed when stale (`--ttl` / dead `--pid`) or with `--force`.
- Always `begin <id>` before acting; resolving (`done`/`fail`/`reconcile`) clears the intent journal.

## Verbs you'll use
```
ledger.mjs   show | next | add <id> <score> "<desc>" | begin <id> [--step act] | done <id> "<line>" --sha x
             fail <id> --error "..." | reconcile --done "<line>" | --retry --error "..." | inflight
             block <id> | unblock <id> | gate <id> pass|fail | fact "..." | decide "..." "why" | lock/unlock --owner <id>
run-gate.mjs <id> | --auto [files...] | --list
doctor.mjs   # health check
tick.mjs     # resume-check (auto-reconcile) + digest + next + relevant gates
selftest.mjs # pin the core's hand-verified edges (exit 0/1; itself a failable gate)
```

## Fan out (when work is wide or needs adversarial verification)
Use the `templates/workflows/` patterns; brief subagents with `templates/agents/` prompts; cheap
model for reads, strong model for synthesis/verify. [P04] Parallel *implementation* uses declared-disjoint
worktrees [P06] — opt-in, only for ≥2 independent substantial edits.

**Context budget — keep subagents in the first ~30% of their window (default) [P09].** Three levers,
honestly scoped: (1) **HARD** — cap the INPUT before spawning: `printf '%s' "$brief" | node
.cadence/lib/context-budget.mjs fits <model> -` (or pass paths). Exit `0` fits · `1` too big · `2`
error/abort; it **fails closed** (an unseeable input never "fits"). (2) **By hand** — if it doesn't fit,
**decompose** into smaller subtasks and fan out (no auto-splitter). (3) **Soft** — brief the budget;
agents self-report `budget.needsDecomposition`. Caveat: `fits` bounds only the *input* — an agent's own
runtime reads aren't hard-bounded, so **scope the task tightly**. `context-budget.mjs budget <model>`
prints the numbers; tune the `context` block in `cadence.config.json`.
