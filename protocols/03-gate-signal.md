# Protocol 03 — Gate signals

Failable checks return a **signal**, never a log. Runner: `lib/run-gate.mjs`. Contract:
`schemas/gate-signal.schema.json`.

## Rules
- MUST run gates via `run-gate.mjs <id>` or `--auto`; NEVER paste raw build/test output into the window.
- A gate returns `{gate, pass, reason, firstError?, ms}`. `reason` distinguishes:
  - `pass` — green.
  - `gate` — the **code** genuinely failed the check (act on it).
  - `error` — the gate couldn't run/parse/timed out (a **config** problem; fix the config, not the code).
- MUST fail **closed**: unparseable output, timeout, or exit 126/127 ⇒ `pass:false`.
- Timeout is enforced **in-process** (Node child_process) — never depend on a `timeout` binary (absent on macOS).
- Write every result to the ledger via `ledger.mjs gate <id> pass|fail` (single writer).

## Failable check
Plant a real error → `{pass:false, reason:"gate", firstError:"file:line"}` in ≤ a few lines, exit 1,
and stdout never contains the full log. A mistyped command → `reason:"error"` (not a false `gate` fail).

## Anti-pattern it prevents
Dumping multi-thousand-line build logs into context, and a broken gate config masquerading as a code failure.
