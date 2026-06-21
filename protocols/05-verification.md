# Protocol 05 — Verification (executable, adversarial, self-applied)

Propose ≠ accept. Findings and edits earn trust through execution, not argument.

## Rules
- **Executable skepticism:** a finding is `confirmed` ONLY with an execution artifact — a failing test, a re-run, or a primary source. Opinion-only findings are `needs-evidence`, never `confirmed`.
- **Adversarially verify before acting:** pressure-test a finding with skeptics on *distinct lenses* (not N identical refuters) before you change anything.
- **Review your own diff:** the orchestrator's OWN changes go to an independent firewalled reviewer (receives ONLY `{diff, currentGoal, relevant facts}`) before commit — the writer never self-certifies.
- **Redundant channels, ranked:** verify behavior on the most deterministic channel available and auto-fall-through (e.g. build+curl → headless DOM → screenshot). The flaky GUI is the last resort, never the only one.

## Failable check
Red-team it: submit one real bug and one fake; the executable verifier confirms only the real one
(the fake's repro won't fail). Plant a flaw in a diff; the reviewer flags it `blocking`.

## Anti-pattern it prevents
Plausible-but-wrong findings shipping because a single agent (or the author) "looked and it seemed fine."
