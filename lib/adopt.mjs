#!/usr/bin/env node
// Cadence adopt — make Cadence apply to ANY project, idempotently.
// Detects EXPLICIT command sources (package.json scripts, Makefile, pyproject,
// Cargo, go.mod) at the root AND in depth-1 subprojects (monorepos -> gates with
// cwd) -> proposes gates; writes .cadence/{config,ledger,lib,.gitignore}; appends
// an AGENTS.md contract block. Never clobbers an existing config or ledger.
//
//   node adopt.mjs [--root <dir>] [--goal "<text>"]
//
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, appendFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { hasIndex, retrievalConfig, offer } from './retrieval.mjs'

const SRC = dirname(fileURLToPath(import.meta.url)) // the framework's lib/ dir
const args = process.argv.slice(2)
const flag = (n) => { const i = args.indexOf(n); return i !== -1 ? args[i + 1] : undefined }
const ROOT = flag('--root') ? join(process.cwd(), flag('--root')) : process.cwd()
const GOAL = flag('--goal') || ''
const CDIR = join(ROOT, '.cadence')
// fail-closed read: returns null on missing / EISDIR (a dir named like a marker) /
// EACCES, so a pathological subdir can't crash adopt mid-write. [M1]
const read = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }

// ── gate detection (explicit sources only — no magic) ─────────────────────────
const FAIL = {
  tsc: 'error TS\\d+', eslint: '(error|\\d+ problems?)', jest: '(\\d+ failing|FAIL\\b|Tests:.*failed)',
  pytest: '(failed|error)\\b', ruff: '((^|\\s)E\\d{3}|error)', cargo: '(test result: FAILED|error\\[E\\d+\\])',
  go: '(--- FAIL|^FAIL\\b)', make: '(Error|error|failed)'
}
// Detect gates for ONE directory (no cwd applied). Returns { gates, notes }.
// bareTests: allow a bare `tests/` dir (no Python marker) to signal a Python project.
// Only the ROOT opts in (legacy heuristic) — for subprojects it would misfire on any
// non-Python subdir that happens to have a tests/ folder, so they require an explicit
// pyproject.toml / tox.ini. [S1]
function gatesForDir (dir, bareTests = false) {
  const gates = {}; const notes = []
  const pkgRaw = read(join(dir, 'package.json'))
  if (pkgRaw) {
    try {
      const scripts = (JSON.parse(pkgRaw).scripts) || {}
      if (scripts.typecheck || scripts['type-check']) gates.typecheck = { cmd: `npm run ${scripts.typecheck ? 'typecheck' : 'type-check'}`, failPattern: FAIL.tsc }
      if (scripts.lint) gates.lint = { cmd: 'npm run lint', failPattern: FAIL.eslint }
      if (scripts.test) gates.test = { cmd: 'npm test --silent', failPattern: FAIL.jest }
      if (scripts.build) gates.build = { cmd: 'npm run build' }
      notes.push('package.json scripts')
    } catch { notes.push('package.json present but unparseable') }
  }
  // bare `tests/` only signals Python at the root, and only when there's no package.json (else it's a JS test dir)
  if (read(join(dir, 'pyproject.toml')) || read(join(dir, 'tox.ini')) || (bareTests && existsSync(join(dir, 'tests')) && !pkgRaw)) {
    gates['test-py'] = { cmd: 'pytest -q', failPattern: FAIL.pytest, successPattern: 'passed' }
    if (read(join(dir, 'pyproject.toml'))?.includes('ruff')) gates['lint-py'] = { cmd: 'ruff check .', failPattern: FAIL.ruff }
    notes.push('Python project')
  }
  if (read(join(dir, 'Cargo.toml'))) { gates['test-rs'] = { cmd: 'cargo test', failPattern: FAIL.cargo }; notes.push('Cargo') }
  if (read(join(dir, 'go.mod'))) { gates['test-go'] = { cmd: 'go test ./...', failPattern: FAIL.go }; notes.push('go.mod') }
  const mk = read(join(dir, 'Makefile'))
  if (mk) { for (const t of ['test', 'build', 'lint', 'check']) if (new RegExp(`^${t}:`, 'm').test(mk) && !gates[t]) gates[t] = { cmd: `make ${t}`, failPattern: FAIL.make }; notes.push('Makefile targets') }
  return { gates, notes }
}

// non-project dirs we never scan for subprojects (plus any dot-dir)
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'vendor', 'target', 'tmp', 'temp'])
const SUBGATE_CAP = 16

function detect () {
  // 1) the root project (gates unprefixed, run at root) — preserves prior behavior
  const root = gatesForDir(ROOT, true)
  const gates = { ...root.gates }
  const notes = root.notes.length ? ['root: ' + root.notes.join(', ')] : []
  // 2) depth-1 subprojects (monorepos): gates get cwd=<dir> and an id prefix. Depth-1
  //    ONLY — so deeply-nested reference projects don't flood the config. NOTE: this
  //    misses depth-2 workspace packages (packages/*, apps/*); add those by hand (a
  //    workspace-glob resolver is a planned follow-up). Sorted for reproducible output. Capped.
  let entries = []
  try { entries = readdirSync(ROOT, { withFileTypes: true }) } catch { /* unreadable root */ }
  entries.sort((a, b) => a.name < b.name ? -1 : 1) // deterministic regardless of FS order [N2]
  const subProjects = []; let subGates = 0; let capped = false
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name) || !/^[A-Za-z0-9._-]+$/.test(e.name)) continue
    const sub = gatesForDir(join(ROOT, e.name)) // subprojects: no bare-tests/ heuristic [S1]
    if (!Object.keys(sub.gates).length) continue
    subProjects.push(e.name)
    for (const [id, g] of Object.entries(sub.gates)) {
      if (subGates >= SUBGATE_CAP) { capped = true; break }
      gates[`${e.name}-${id}`] = { ...g, cwd: e.name }
      subGates++
    }
    if (capped) break
  }
  if (subProjects.length) notes.push(`subprojects: ${subProjects.join(', ')}`)
  if (capped) notes.push(`(capped at ${SUBGATE_CAP} subproject gates — add more by hand)`)
  return { gates, notes }
}

// ── AGENTS.md contract block ──────────────────────────────────────────────────
const AGENTS_SNIPPET = `\n<!-- cadence:start -->\n## Working in this repo (Cadence loop)\n\nThis project runs a **Cadence** loop — a stateless orchestrator over a durable ledger.\n\n- **State lives in \`.cadence/loop-state.json\`.** Read it with \`node .cadence/lib/ledger.mjs show\` at the START of any pass. It — not the chat transcript — is the source of truth.\n- **Ingest conclusions, not corpora.** Never read whole files or raw logs into your own context. Delegate high-volume reading to subagents that return distilled, structured results.\n- **Retrieval-first (Protocol 07).** For where/what/blast-radius questions, prefer a code graph when present: if \`.codegraph/\` exists, reach for \`codegraph explore\`/\`codegraph node\` (or the codegraph MCP tools) BEFORE grep + whole-file reads; fall back to \`rg -n\`. Cheaper, tighter context.\n- **Run gates via the wrapper, never raw:** \`node .cadence/lib/run-gate.mjs --auto\` (or \`<gateId>\`). It returns a pass/fail SIGNAL; never paste full build logs.\n- **Close the loop:** on a green gate \`ledger.mjs done <id> "<line>"\`; on red \`ledger.mjs fail <id> --error "<firstError>"\` (re-opens the item with context). Record durable knowledge with \`ledger.mjs fact\`, decisions with \`ledger.mjs decide\`.\n- **Crash-safe:** \`ledger.mjs lock --owner <id>\` at session start (\`unlock\` at end); \`ledger.mjs begin <id>\` BEFORE acting (write-ahead intent). On resume, \`node .cadence/lib/tick.mjs\` auto-reconciles an interrupted tick — no lost or double-done work.\n- **Commit only the files you wrote. Pause (don't churn) when no high-value pending item remains.**\n\nFull protocols: \`.cadence/lib/../\` docs, or the Cadence source \`protocols/\`.\n<!-- cadence:end -->\n`

// ── apply ─────────────────────────────────────────────────────────────────────
mkdirSync(join(CDIR, 'lib'), { recursive: true })
for (const f of ['ledger.mjs', 'run-gate.mjs', 'relevance.mjs', 'doctor.mjs', 'tick.mjs', 'context-budget.mjs', 'retrieval.mjs', 'selftest.mjs']) {
  copyFileSync(join(SRC, f), join(CDIR, 'lib', f))
}
// Copy schemas too so the target is self-contained and $schema refs resolve in editors.
const SCHEMA_SRC = join(SRC, '..', 'schemas')
for (const f of ['adapter.schema.json', 'loop-state.schema.json', 'gate-signal.schema.json', 'subagent-result.schema.json']) {
  if (existsSync(join(SCHEMA_SRC, f))) copyFileSync(join(SCHEMA_SRC, f), join(CDIR, 'lib', f))
}
console.log('✓ copied core scripts + schemas -> .cadence/lib/')

// Gitignore the VOLATILE loop state so it stays out of the project's `git status`/diff
// and is never committed by accident. (It also keeps the untracked ledger from tripping
// relevance's all-gates fallback WHEN relevance is enabled.) config / lib / plan stay
// trackable. Idempotent: only written if absent.
const giPath = join(CDIR, '.gitignore')
if (!existsSync(giPath)) {
  writeFileSync(giPath, '# Cadence — machine-local, volatile loop state (do not commit).\n# Tracked: cadence.config.json, lib/, plan/.  Ignored: the runtime state below.\nloop-state.json\nloop-state.json.tmp\nfacts.jsonl\nloop.lock\n')
  console.log('✓ wrote .cadence/.gitignore (ignores local loop state)')
}

const cfgPath = join(CDIR, 'cadence.config.json')
if (existsSync(cfgPath)) {
  console.log('• .cadence/cadence.config.json exists — left untouched')
} else {
  const { gates, notes } = detect()
  const cfg = { $schema: './lib/adapter.schema.json', project: require_basename(ROOT), gates: Object.keys(gates).length ? gates : { TODO: { cmd: 'echo \"define a gate: a command that exits non-zero on failure\" && exit 1' } }, relevance: { enabled: false, rules: [] }, ...(hasIndex(ROOT) ? { retrieval: retrievalConfig() } : {}) }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  console.log(`✓ wrote .cadence/cadence.config.json  (${notes.join('; ') || 'no gates auto-detected — edit it'})`)
  console.log(`  gates: ${Object.keys(cfg.gates).join(', ')}`)
}

const ledPath = join(CDIR, 'loop-state.json')
if (existsSync(ledPath)) {
  console.log('• .cadence/loop-state.json exists — left untouched (your run state is safe)')
} else {
  // When a goal is given, seed ONE high-score planning item so `adopt → tick` flows
  // straight into a planning tick (Protocol 10) instead of an empty backlog.
  const planItem = { id: 'plan-backlog', score: 100, desc: 'Plan: decompose the goal into scored, gate-verifiable, pre-resolved backlog items (Protocol 10)' }
  const seed = { version: 1, updated: new Date().toISOString(), currentGoal: GOAL, tick: 0, config: { recentDecisionsCap: 5, factsInlineCap: 40, factsFile: '.cadence/facts.jsonl' }, pending: GOAL ? [planItem] : [], done: [], blockedOnOwner: [], verifiedFacts: [], recentDecisions: [], gates: {} }
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

// CLAUDE.md is a thin @AGENTS.md import so Claude Code picks up the same contract
// (AGENTS.md stays the single source of truth read natively by other agents).
const claudePath = join(ROOT, 'CLAUDE.md')
const claude = read(claudePath)
if (claude && /@AGENTS\.md/.test(claude)) {
  console.log('• CLAUDE.md already imports @AGENTS.md — left untouched')
} else if (claude) {
  appendFileSync(claudePath, '\n@AGENTS.md\n'); console.log('✓ added the @AGENTS.md import to CLAUDE.md')
} else {
  writeFileSync(claudePath, '# CLAUDE.md\n\nClaude Code reads this file; other agents read AGENTS.md. Single source of truth:\n\n@AGENTS.md\n'); console.log('✓ created CLAUDE.md (thin @AGENTS.md import)')
}

// Retrieval-first is an opt-in accelerator (Protocol 07). If this repo isn't indexed,
// OFFER to set it up — never auto-install (it's an external tool + a network action).
const retrievalOffer = offer(ROOT)
if (retrievalOffer) console.log('\n' + retrievalOffer)

console.log('\nNext: node .cadence/lib/doctor.mjs   then   node .cadence/lib/ledger.mjs show')

function require_basename (p) { return p.split('/').filter(Boolean).pop() || 'project' }
