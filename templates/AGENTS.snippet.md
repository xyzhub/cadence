<!-- cadence:start -->
## Working in this repo (Cadence loop)

This project runs a **Cadence** loop — a stateless orchestrator over a durable ledger.

- **State lives in `.cadence/loop-state.json`.** Read it with `node .cadence/lib/ledger.mjs show` at the START of any pass. It — not the chat transcript — is the source of truth.
- **Ingest conclusions, not corpora.** Never read whole files or raw logs into your own context. Delegate high-volume reading to subagents that return distilled, pointer-only results.
- **Run gates via the wrapper, never raw:** `node .cadence/lib/run-gate.mjs --auto` (or `<gateId>`). It returns a pass/fail SIGNAL; never paste full build logs. `reason:"error"` means the gate config is broken, not the code.
- **Close the loop:** green → `ledger.mjs done <id> "<line>"`; red → `ledger.mjs fail <id> --error "<firstError>"` (re-opens the item with context). Record durable knowledge with `ledger.mjs fact`, decisions with `ledger.mjs decide`.
- **Commit only the files you wrote. Pause (don't churn) when no high-value pending item remains.**

Full protocols: the Cadence source `protocols/`.
<!-- cadence:end -->
