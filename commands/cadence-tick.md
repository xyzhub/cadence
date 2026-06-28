---
description: Cadence — run exactly one tick (one pass); pairs with /loop
---

Run a **single** Cadence pass, then stop. If there is no `.cadence/` directory, tell the user to run
`/cadence init "<goal>"` first.

To run on an interval, put this behind the loop skill: `/loop 10m /cadence-tick`.

@${CLAUDE_PLUGIN_ROOT}/templates/tick.procedure.md
