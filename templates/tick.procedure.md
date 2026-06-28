<!-- Canonical Cadence one-pass procedure. Shared source of truth, @-embedded by
     commands/cadence.md (the `tick`/`start` verbs) and commands/cadence-tick.md.
     Edit here — not in the commands — so the procedure stays DRY. -->

# Cadence — one tick (one pass)

You are the **orchestrator** of a Cadence loop: a stateless controller over the durable ledger at
`.cadence/loop-state.json`. Do **not** rely on the chat transcript — the ledger is the source of
truth. Run exactly **one** pass, then stop. (Repeat by running again, or put `/cadence-tick` behind
`/loop`.)

**Preflight.** If there is no `.cadence/` directory, this repo isn't adopted — tell the user to run
`/cadence init "<goal>"` first, and stop.

1. **Digest.** Run `node .cadence/lib/tick.mjs`. It auto-reconciles any interrupted prior tick (crash
   recovery), then prints the ledger digest, the next item, and the relevant gate signals. Read only
   this — never the whole ledger file or raw logs.
   - If it reports an interrupted tick awaiting confirmation (a **GREEN gate on resume**), resolve it
     with `node .cadence/lib/ledger.mjs reconcile --done "<what shipped>"` (or `--retry --error
     "..."`) and stop — that reconciliation **was** your pass.

2. **Pick the item.** Take the highest-value `pending` item from the digest. If it carries a
   `lastError`, your job is to address that error. **If the item is `plan-backlog`, or the queue is
   empty/thin, do NOT execute — run the planning procedure instead** (`/cadence plan`).
   - Read the item's `brief` pointer (e.g. `.cadence/plan/<goal>.briefs.md#<id>`) and read **only**
     what the brief lists (files + line regions + anchors). Do not explore. If the brief
     under-resolves its targets, fix the plan rather than widening your window.

3. **Declare intent.** `node .cadence/lib/ledger.mjs begin <id> --step act` **before any side effect**
   (write-ahead journal — this is what makes the pass crash-safe).

4. **Act.** Make the change.
   - **Fan out** for wide or risky work using the patterns in
     `${CLAUDE_PLUGIN_ROOT}/templates/workflows/` (cheap tier for reads, strong tier for
     synthesis/verify). Subagents return **distilled, pointer-only** results — you ingest conclusions,
     never corpora or raw logs.
   - **Context budget [P09]:** before spawning a subagent, keep its INPUT in the first ~30% of its
     window — `printf '%s' "$brief" | node .cadence/lib/context-budget.mjs fits <model> -` (exit `0`
     fits · `1` too big → decompose and fan out · `2` error; it **fails closed**). Scope each task
     tightly — the cap bounds input only.

5. **Gate.** Run `node .cadence/lib/run-gate.mjs --auto`. Treat the JSON **signal**, never raw logs:
   `reason:"gate"` = a real code failure (**fix the code**); `reason:"error"` = a config/run problem
   (**fix the gate**). Record it: `node .cadence/lib/ledger.mjs gate <id> pass|fail`.

6. **Verify + review.** Confirm by **execution** (a real artifact, not an assertion). Send your own
   diff to an independent reviewer subagent before you commit.

7. **Close the loop.**
   - **Green** → `node .cadence/lib/ledger.mjs done <id> "<one-line result>" --sha <sha>`, then commit
     **only the files you wrote**.
   - **Red** → `node .cadence/lib/ledger.mjs fail <id> --error "<firstError>"` (re-opens with context).
   - **Empty diff / decision-only** → `node .cadence/lib/ledger.mjs decide "<what>" "<why>"`, no commit.

8. **Persist + end.** Record durable knowledge with `node .cadence/lib/ledger.mjs fact "..."` and the
   rationale with `node .cadence/lib/ledger.mjs decide "..." "why"`. End the pass — discard the window;
   the ledger carries state to the next tick.

**Pause, don't churn.** If the top pending score is below threshold, every remaining item is
`blockedOnOwner`, or two ticks produced no high-value change: **stop and hand back**. Summarize from
`node .cadence/lib/ledger.mjs show` and list the owner-blocked items.
