// RUN VIA THE WORKFLOW TOOL, not `node` — the body executes in an async context
// where top-level await/return and agent()/parallel()/pipeline()/args are provided.
// Cadence workflow template — find -> verify -> fix (pipeline, no barriers).
// Each finding flows straight to verification then fix as soon as it's found;
// nothing waits on a barrier. Adapt the dimensions + gate to your project.
export const meta = {
  name: 'find-verify-fix',
  description: 'Find issues across dimensions, executably verify each, fix only confirmed ones',
  phases: [{ title: 'Find' }, { title: 'Verify' }, { title: 'Fix' }],
}

const DIMENSIONS = args?.dimensions || [
  { key: 'bugs', prompt: 'Find correctness bugs in the changed files. Return findings as pointers (file:line), no excerpts.' },
  { key: 'security', prompt: 'Find security issues (injection, authz, secrets) in the changed files. Pointers only.' },
]
const FINDINGS = { type: 'object', additionalProperties: false, required: ['findings'], properties: { findings: { type: 'array', maxItems: 25, items: { type: 'object', additionalProperties: false, required: ['claim', 'pointer'], properties: { claim: { type: 'string', maxLength: 240 }, pointer: { type: 'string' }, severity: { type: 'string' } } } } } }
const VERDICT = { type: 'object', additionalProperties: false, required: ['confirmed'], properties: { confirmed: { type: 'boolean' }, evidence: { type: 'string', description: 'pointer to a failing test / re-run' }, fix: { type: 'string' } } }

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { label: `find:${d.key}`, phase: 'Find', schema: FINDINGS, agentType: 'Explore' }),
  (review, d) => parallel((review?.findings || []).map(f => () =>
    // executable skepticism: confirm ONLY with an artifact (Protocol 05)
    agent(`Adversarially verify by EXECUTION (write/run a minimal repro): ${f.claim} @ ${f.pointer}. Default confirmed=false unless the repro fails.`,
      { label: `verify:${d.key}`, phase: 'Verify', schema: VERDICT, agentType: 'general-purpose' })
      .then(v => ({ ...f, verdict: v })))),
)
const confirmed = results.flat().filter(Boolean).filter(f => f.verdict?.confirmed)
// The ORCHESTRATOR applies fixes for `confirmed` and runs the gate signal — agents propose, orchestrator disposes.
return { confirmed }
