# Protocol 01 — Context firewall

Subagents quarantine high-volume, low-density work in disposable windows. Only distilled
conclusions cross back to the orchestrator.

## Rules
- The orchestrator MUST ingest **conclusions, not corpora**: never read whole files, web pages, or raw tool/build logs into its own window.
- Delegate all volume reading/research/scanning to subagents; they return `subagent-result.schema.json` — **pointers, not payloads** (`file:line`, never embedded excerpts), with array/length caps.
- Trivial inline edits are fine; *raw material* never is.
- Reduce any unavoidable large output through a script that prints only the decision-relevant slice before it reaches the window.

## Failable check
Audit one tick's tool calls: assert **0** whole-file reads and **0** tool results above ~K lines
entered the orchestrator window. A finding that embeds an excerpt instead of a pointer fails the contract.

## Anti-pattern it prevents
The orchestrator "just reading" files/logs for convenience — the most common self-inflicted context bloat.
