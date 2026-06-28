---
description: Cadence — onboard, plan, and run long-horizon work over a durable ledger
argument-hint: "[init|start|tick|status|plan|add|pause|resume|doctor] [args]"
---

# /cadence — orchestration loop dispatcher

- Repo adopted: !`test -d .cadence && echo "yes (.cadence/ present)" || echo "no — run /cadence init first"`
- Branch: !`git branch --show-current 2>/dev/null || echo "(no git)"`

You are dispatching a **Cadence** command. The user's full input is:

> $ARGUMENTS

**Route on the FIRST word** (the verb); the rest is that verb's argument (a goal, a description, or
flags). If there is **no verb**, print the **Usage** block at the bottom and stop. Every verb
**except `init`** requires `.cadence/` to exist — if it doesn't, tell the user to run
`/cadence init "<goal>"` first and stop. Run only the section for the matched verb.

> Path rule: `init` runs the bootstrap from the plugin (`${CLAUDE_PLUGIN_ROOT}/lib/adopt.mjs`, which is
> *not* copied into projects). **Every other verb uses the repo-local `.cadence/lib/` copy.**

---

## init — onboard this repo (new OR existing), then offer to plan
The argument (if any) is the **goal**. adopt is idempotent and never clobbers an existing
config/ledger, so it is safe on an already-adopted repo (it just syncs the core + wiring).

1. **Preview?** If the argument contains `--dry-run`, run
   `node "${CLAUDE_PLUGIN_ROOT}/lib/adopt.mjs" --dry-run` (add `--goal "<goal>"` if a goal was given),
   report what it *would* write, and stop.
2. **Adopt:** `node "${CLAUDE_PLUGIN_ROOT}/lib/adopt.mjs" --goal "<goal>"` (omit `--goal` if no goal
   was given).
3. **Validate:** `node .cadence/lib/doctor.mjs`. Summarize the detected gates, the seeded goal, and
   doctor's verdict in a few lines.
4. **Then OFFER to plan.** Use the **AskUserQuestion** tool to ask: *"Setup complete. Run a planning
   tick now to decompose the goal into a scored backlog?"* with options **Yes — plan now** and
   **No — I'll start later**.
   - **Yes** → run the **Planning procedure** below, once.
   - **No** → print next steps: `/cadence plan` · `/cadence start` · `/cadence status`.

## start — run the autonomous loop (multi-tick) until a pause condition
The argument (if any) refreshes the goal (`node .cadence/lib/ledger.mjs decide "refocus goal: <goal>" "user"`).
1. **Lock** (single-writer): `node .cadence/lib/ledger.mjs lock --owner <owner>` — pick a stable
   `<owner>` such as the branch name (fallback `cadence`). If the lock is refused, report who holds it
   and stop.
2. **Loop:** repeat the **One-tick procedure** below, pass after pass, **until a pause condition**
   holds — top pending score below threshold, every remaining item `blockedOnOwner`, or two
   consecutive ticks made no high-value change.
3. **Unlock + summarize:** `node .cadence/lib/ledger.mjs unlock --owner <owner>`, then summarize what
   shipped (from `node .cadence/lib/ledger.mjs show`) and list any owner-blocked items.

Relay once: to run on a fixed cadence instead of in-session, use **`/loop 10m /cadence-tick`**.

## tick — run exactly one pass
Follow the **One-tick procedure** below, once, then stop.

## plan — force one planning tick
The argument (if any) refreshes the goal. Follow the **Planning procedure** below, once.

## status — read-only snapshot
Run `node .cadence/lib/ledger.mjs show`, then `node .cadence/lib/ledger.mjs next`. Report the digest +
the next item, and point to the dashboard `.cadence/cadence-overview.html` (offer to (re)generate it
with `node .cadence/lib/overview.mjs --open`). **Do not mutate anything.**

## add — quick-add a pending item
Parse the argument as `"<desc>" [--gate <id>] [--accept "<criterion>"] [--score <n>]`, derive a short
kebab `<slug>` from the description, then run
`node .cadence/lib/ledger.mjs add <slug> <score|default 5> "<desc>" [--gate <id>] [--accept "<criterion>"]`.
Confirm by echoing `node .cadence/lib/ledger.mjs next`.

## pause — hand back cleanly
`node .cadence/lib/ledger.mjs unlock --owner <owner>` (best-effort), then summarize current state +
owner-blocked items from `node .cadence/lib/ledger.mjs show`.

## resume — pick back up
`node .cadence/lib/ledger.mjs lock --owner <owner>`, then show `node .cadence/lib/ledger.mjs next`.
Suggest `/cadence tick` (one pass) or `/cadence start` (autonomous).

## doctor — health check
Run `node .cadence/lib/doctor.mjs` and report its verdict (and how to fix any ✗ items).

---

# One-tick procedure
@${CLAUDE_PLUGIN_ROOT}/templates/tick.procedure.md

# Planning procedure
@${CLAUDE_PLUGIN_ROOT}/templates/plan.procedure.md

---

# Usage (print this when no verb was given)
```
/cadence init "<goal>"     onboard this repo (new or existing), then offer to plan
/cadence init --dry-run    preview adoption — detect gates, write nothing
/cadence plan ["<goal>"]   decompose the goal into a scored, gate-verifiable backlog
/cadence start ["<goal>"]  run the autonomous loop until a pause condition
/cadence tick              run exactly one pass         (also: /cadence-tick)
/cadence status            read-only ledger + dashboard (also: /cadence-status)
/cadence add "<desc>" [--gate g] [--accept "..."]      quick-add a pending item
/cadence pause | resume    unlock + summarize  |  lock + show next
/cadence doctor            health check

Run the loop on an interval:  /loop 10m /cadence-tick
```
