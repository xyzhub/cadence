# Protocol 04 — Fan-out & model tiering

Parallelize for breadth; funnel verification through one orchestrator. Templates in
`templates/workflows/`, agent prompts in `templates/agents/`.

## Rules
- Default to `pipeline` (find→verify→fix, no barriers); use a barrier only when a stage needs ALL prior results (dedup, early-exit on zero, cross-item comparison).
- Every subagent returns a structured schema (`subagent-result.schema.json`) — no prose dumps.
- **Model tiering:** cheap model for mechanical reads/extraction (`scout`); strong model for synthesis and adversarial verify; reserve the highest effort for the hardest verify/judge stages.
- Scale fan-out width to the task — a quick check is a couple of agents; an audit is a panel.
- NEVER split one coherent thought across agents just to parallelize.

## Failable check
A workflow run's per-agent log shows reads on the cheap tier and synthesis/verify on the strong tier,
with a measured token drop versus an all-default run yielding the same confirmed findings.

## Anti-pattern it prevents
Doing serially what agents could do in parallel — and burning the strong model on mechanical reads.
