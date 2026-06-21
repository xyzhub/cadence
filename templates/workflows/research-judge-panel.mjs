// RUN VIA THE WORKFLOW TOOL, not `node` — the body executes in an async context
// where top-level await/return and agent()/parallel()/phase()/args are provided.
// Cadence workflow template — research -> synthesize -> judge panel.
// Parallel researchers (cheap tier) gather; one synthesizer (strong tier) picks;
// a diverse-lens skeptic panel pressure-tests the pick before you act on it.
export const meta = {
  name: 'research-judge-panel',
  description: 'Multi-source research, synthesized recommendation, adversarially judged on distinct lenses',
  phases: [{ title: 'Research' }, { title: 'Synthesize' }, { title: 'Judge' }],
}

const TOPICS = args?.topics || []          // [{ key, prompt }] — one researcher each
const LENSES = args?.lenses || ['cost/economics', 'feasibility/reality', 'risk/lock-in']
const RSCHEMA = { type: 'object', additionalProperties: false, required: ['summary', 'sources'], properties: { summary: { type: 'string', maxLength: 800 }, facts: { type: 'array', items: { type: 'string' } }, sources: { type: 'array', items: { type: 'string' } } } }
const REC = { type: 'object', additionalProperties: false, required: ['recommendation', 'rationale'], properties: { recommendation: { type: 'string' }, runnerUp: { type: 'string' }, rationale: { type: 'string' }, risks: { type: 'array', items: { type: 'string' } } } }
const VERDICT = { type: 'object', additionalProperties: false, required: ['lens', 'agree'], properties: { lens: { type: 'string' }, agree: { type: 'boolean' }, strongestObjection: { type: 'string' }, adjustment: { type: 'string' } } }

phase('Research')
const research = (await parallel(TOPICS.map(t => () =>
  agent(t.prompt, { label: `research:${t.key}`, phase: 'Research', schema: RSCHEMA, agentType: 'general-purpose' })))).filter(Boolean)

phase('Synthesize')
const rec = await agent(`Pick the best option for: ${args?.question || meta.description}. Weigh the research and give a recommendation + runner-up + rationale + risks.\n\n${JSON.stringify(research)}`,
  { label: 'synthesize', phase: 'Synthesize', schema: REC, agentType: 'general-purpose' })

phase('Judge')
const verdicts = (await parallel(LENSES.map(lens => () =>
  agent(`Adversarially pressure-test this recommendation through the ${lens} lens. Be specific; surface the strongest objection and any adjustment.\n\n${JSON.stringify(rec)}`,
    { label: `judge:${lens}`, phase: 'Judge', schema: VERDICT, agentType: 'general-purpose' })))).filter(Boolean)

return { research, recommendation: rec, verdicts }
