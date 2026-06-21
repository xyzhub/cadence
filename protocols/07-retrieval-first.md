# Protocol 07 — Retrieval-first

Prefer compressed, targeted retrieval over whole-file reads. Configured via the adapter's
`retrieval` block (probe order, e.g. `codegraph explore` → `rg`). Helper for subagents: keep reads narrow.

## Rules
- For "where/what" questions (where is X used, all exported types, call paths), MUST query a code graph / `grep -n` for the slice — NOT read entire files.
- Reads MUST be narrow ranges, not whole files; re-deriving a fact via a targeted query beats carrying the file forward.
- This applies doubly to subagents (they can read widely, but should still return pointers, per Protocol 01).

## Failable check
Answer a "find all X" question via one retrieval query returning fewer tokens than grep+read would,
and cross-check it matches a grep ground-truth once. If the graph under-indexes a file type, fall back to grep for that class.

## Anti-pattern it prevents
Whole-file reads as the default lookup — the silent tax that fills the window with material you didn't need.
