// RUN VIA THE WORKFLOW TOOL, not `node` — the body executes in an async context
// where top-level await/return and agent()/parallel()/pipeline()/phase()/args are provided.
// Cadence workflow template — audit -> skeptic panel -> fix.
// Fan out readers over asset/route groups, dedup, then run a small skeptic panel
// on flagged items so only REAL gaps survive to the fix stage. Barrier is used
// deliberately: dedup needs ALL audit results before verification.
export const meta = {
  name: 'audit-skeptic-fix',
  description: 'Audit groups in parallel, dedup, skeptic-verify each gap, surface only confirmed ones',
  phases: [{ title: 'Audit' }, { title: 'Verify' }],
}

const GROUPS = args?.groups || [] // [{ key, prompt }]
const FINDING = { type: 'object', additionalProperties: false, required: ['assets'], properties: { assets: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: ['id', 'gap', 'severity'], properties: { id: { type: 'string' }, gap: { type: 'string', maxLength: 240 }, pointer: { type: 'string' }, severity: { type: 'string', enum: ['high', 'medium', 'low', 'none'] } } } } } }
const VERDICT = { type: 'object', additionalProperties: false, required: ['id', 'isRealGap'], properties: { id: { type: 'string' }, isRealGap: { type: 'boolean' }, reasoning: { type: 'string' }, fix: { type: 'string' } } }

phase('Audit')
const audits = (await parallel(GROUPS.map(g => () =>
  agent(g.prompt, { label: `audit:${g.key}`, phase: 'Audit', schema: FINDING, agentType: 'Explore' })))).filter(Boolean)

// barrier is justified: dedup needs every result before the (costly) skeptic pass
const flagged = audits.flatMap(a => a.assets).filter(a => a.severity === 'high' || a.severity === 'medium')
const seen = new Set(); const deduped = flagged.filter(f => { const k = f.id + '|' + f.gap; if (seen.has(k)) return false; seen.add(k); return true })

phase('Verify')
const verdicts = (await parallel(deduped.map(f => () =>
  agent(`Skeptically determine if this is a REAL gap worth fixing or a false positive (already handled / by-design). Read the actual source before deciding; default isRealGap=false unless you can point to the specific missing behavior. Gap: ${f.gap} @ ${f.pointer || f.id}`,
    { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT, agentType: 'general-purpose' })))).filter(Boolean)

return { confirmed: verdicts.filter(v => v.isRealGap), rejected: verdicts.filter(v => !v.isRealGap) }
