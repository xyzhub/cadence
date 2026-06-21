#!/usr/bin/env node
// Cadence adopt — make Cadence apply to ANY project, idempotently.
// Detects EXPLICIT command sources (package.json scripts, Makefile, pyproject,
// Cargo, go.mod) -> proposes gates; writes .cadence/{config,ledger,lib}; appends
// an AGENTS.md contract block. Never clobbers an existing config or ledger.
//
//   node adopt.mjs [--root <dir>] [--goal "<text>"]
//
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url)) // the framework's lib/ dir
const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined }
const ROOT = flag('--root') ? join(process.cwd(), flag('--root')) : process.cwd()
const GOAL = flag('--goal') || ''
const CDIR = join(ROOT, '.cadence')
const read = (p) => existsSync(p) ? readFileSync(p, 'utf8') : null

// ── gate detection (explicit sources only — no magic) ─────────────────────────
const FAIL = {
  tsc: 'error TS\\d+', eslint: '(error|\\d+ problems?)', jest: '(\\d+ failing|FAIL\\b|Tests:.*failed)',
  pytest: '(failed|error)\\b', ruff: '((^|\\s)E\\d{3}|error)', cargo: '(test result: FAILED|error\\[E\\d+\\])',
  go: '(--- FAIL|^FAIL\\b)', make: '(Error|error|failed)'
}
function detect () {
  const gates = {}; const notes = []
  const pkgRaw = read(join(ROOT, 'package.json'))
  if (pkgRaw) {
    try {
      const scripts = (JSON.parse(pkgRaw).scripts) || {}
      if (scripts.typecheck || scripts['type-check']) gates.typecheck = { cmd: `npm run ${scripts.typecheck ? 'typecheck' : 'type-check'}`, failPattern: FAIL.tsc }
      if (scripts.lint) gates.lint = { cmd: 'npm run lint', failPattern: FAIL.eslint }
      if (scripts.test) gates.test = { cmd: 'npm test --silent', failPattern: FAIL.jest }
      if (scripts.build) gates.build = { cmd: 'npm run build' }
      notes.push('detected package.json scripts')
    } catch { notes.push('package.json present but unparseable — add gates by hand') }
  }
  if (read(join(ROOT, 'pyproject.toml')) || read(join(ROOT, 'tox.ini')) || existsSync(join(ROOT, 'tests'))) {
    gates['test-py'] = { cmd: 'pytest -q', failPattern: FAIL.pytest, successPattern: 'passed' }
    if (read(join(ROOT, 'pyproject.toml'))?.includes('ruff')) gates['lint-py'] = { cmd: 'ruff check .', failPattern: FAIL.ruff }
    notes.push('detected Python project')
  }
  if (read(join(ROOT, 'Cargo.toml'))) { gates['test-rs'] = { cmd: 'cargo test', failPattern: FAIL.cargo }; notes.push('detected Cargo') }
  if (read(join(ROOT, 'go.mod'))) { gates['test-go'] = { cmd: 'go test ./...', failPattern: FAIL.go }; notes.push('detected go.mod') }
  const mk = read(join(ROOT, 'Makefile'))
  if (mk) { for (const t of ['test', 'build', 'lint', 'check']) if (new RegExp(`^${t}:`, 'm').test(mk) && !gates[t]) gates[t] = { cmd: `make ${t}`, failPattern: FAIL.make }; notes.push('detected Makefile targets') }
  return { gates, notes }
}

// ── AGENTS.md contract block ──────────────────────────────────────────────────
const AGENTS_SNIPPET = `\n<!-- cadence:start -->\n## Working in this repo (Cadence loop)\n\nThis project runs a **Cadence** loop — a stateless orchestrator over a durable ledger.\n\n- **State lives in \`.cadence/loop-state.json\`.** Read it with \`node .cadence/lib/ledger.mjs show\` at the START of any pass. It — not the chat transcript — is the source of truth.\n- **Ingest conclusions, not corpora.** Never read whole files or raw logs into your own context. Delegate high-volume reading to subagents that return distilled, structured results.\n- **Run gates via the wrapper, never raw:** \`node .cadence/lib/run-gate.mjs --auto\` (or \`<gateId>\`). It returns a pass/fail SIGNAL; never paste full build logs.\n- **Close the loop:** on a green gate \`ledger.mjs done <id> "<line>"\`; on red \`ledger.mjs fail <id> --error "<firstError>"\` (re-opens the item with context). Record durable knowledge with \`ledger.mjs fact\`, decisions with \`ledger.mjs decide\`.\n- **Commit only the files you wrote. Pause (don't churn) when no high-value pending item remains.**\n\nFull protocols: \`.cadence/lib/../\` docs, or the Cadence source \`protocols/\`.\n<!-- cadence:end -->\n`

// ── apply ─────────────────────────────────────────────────────────────────────
mkdirSync(join(CDIR, 'lib'), { recursive: true })
for (const f of ['ledger.mjs', 'run-gate.mjs', 'relevance.mjs', 'doctor.mjs', 'tick.mjs']) {
  copyFileSync(join(SRC, f), join(CDIR, 'lib', f))
}
// Copy schemas too so the target is self-contained and $schema refs resolve in editors.
const SCHEMA_SRC = join(SRC, '..', 'schemas')
for (const f of ['adapter.schema.json', 'loop-state.schema.json', 'gate-signal.schema.json', 'subagent-result.schema.json']) {
  if (existsSync(join(SCHEMA_SRC, f))) copyFileSync(join(SCHEMA_SRC, f), join(CDIR, 'lib', f))
}
console.log('✓ copied core scripts + schemas -> .cadence/lib/')

const cfgPath = join(CDIR, 'cadence.config.json')
if (existsSync(cfgPath)) {
  console.log('• .cadence/cadence.config.json exists — left untouched')
} else {
  const { gates, notes } = detect()
  const cfg = { $schema: './lib/adapter.schema.json', project: require_basename(ROOT), gates: Object.keys(gates).length ? gates : { TODO: { cmd: 'echo \"define a gate: a command that exits non-zero on failure\" && exit 1' } }, relevance: { enabled: false, rules: [] } }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  console.log(`✓ wrote .cadence/cadence.config.json  (${notes.join('; ') || 'no gates auto-detected — edit it'})`)
  console.log(`  gates: ${Object.keys(cfg.gates).join(', ')}`)
}

const ledPath = join(CDIR, 'loop-state.json')
if (existsSync(ledPath)) {
  console.log('• .cadence/loop-state.json exists — left untouched (your run state is safe)')
} else {
  const seed = { version: 1, updated: new Date().toISOString(), currentGoal: GOAL, tick: 0, config: { recentDecisionsCap: 5, factsInlineCap: 40, factsFile: '.cadence/facts.jsonl' }, pending: [], done: [], blockedOnOwner: [], verifiedFacts: [], recentDecisions: [], gates: {} }
  writeFileSync(ledPath, JSON.stringify(seed, null, 2))
  console.log('✓ seeded .cadence/loop-state.json')
}

const agentsPath = join(ROOT, 'AGENTS.md')
const existing = read(agentsPath)
if (existing && existing.includes('<!-- cadence:start -->')) {
  console.log('• AGENTS.md already has the Cadence block — left untouched')
} else if (existing) {
  appendFileSync(agentsPath, AGENTS_SNIPPET); console.log('✓ appended the Cadence block to AGENTS.md')
} else {
  writeFileSync(agentsPath, `# AGENTS.md\n${AGENTS_SNIPPET}`); console.log('✓ created AGENTS.md with the Cadence block')
}

console.log('\nNext: node .cadence/lib/doctor.mjs   then   node .cadence/lib/ledger.mjs show')

function require_basename (p) { return p.split('/').filter(Boolean).pop() || 'project' }
