# Protocol 06 — Parallel worktrees (OPT-IN, heavy)

Parallel *implementation* (not just discovery) with one accountable verifier. Enable only when a pass
has ≥2 genuinely independent substantial edits; per-worktree setup has real cost. This is the heaviest
opt-in part and is intentionally **not shipped as a core script** — drive it with the Workflow tool's
native `isolation:'worktree'` (one agent per declared-disjoint task), the `parallel` block in
`cadence.config.json`, and `templates/agents/disjoint-implementer.md`. Add a thin `lib/worktree.mjs`
only if you outgrow the platform's native isolation.

## Rules
- Tasks MUST **declare their file globs up front**. Overlapping declarations are REJECTED at planning — not discovered at merge.
- Each implementer works in its own git worktree (`isolation:'worktree'`) and returns `{branch, changedFiles, selfGate}`.
- The orchestrator merges only branches whose `selfGate` passed, then runs the gate signal on the **union** as the final ground truth.
- Non-JS stacks: set per-worktree `setup`/`env` in config (venv, `CARGO_TARGET_DIR`, etc.).
- Stage and commit only the files a task declared it wrote.

## Failable check
Two disjoint tasks → both merge, union gate passes. Two overlapping declarations → rejected at
planning with the overlapping glob named. A task whose `selfGate` failed is never merged.

## Anti-pattern it prevents
Parallel writers silently clobbering each other, or the orchestrator merging unverified work.
