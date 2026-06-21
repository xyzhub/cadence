#!/usr/bin/env node
// Cadence ledger — the orchestrator's durable external memory ("RAM").
// Dependency-free Node ESM. Library + CLI. The orchestrator reconstructs a
// BOUNDED working context from `show` each tick instead of carrying a transcript.
//
//   node ledger.mjs init [--goal "..."]
//   node ledger.mjs show                 # the per-tick digest (small, bounded)
//   node ledger.mjs next                 # highest-scored pending item (JSON)
//   node ledger.mjs add <id> <score> "<desc>" [--effort small] [--owner]
//   node ledger.mjs done <id> "<line>" [--sha abc]
//   node ledger.mjs fail <id> --error "<firstError>" [--because "<ranBecause>"]
//   node ledger.mjs block <id> | unblock <id>
//   node ledger.mjs gate <id> pass|fail [--error "..."] [--because "..."] [--ms 1234]
//   node ledger.mjs fact "<one-line>" [--pointer file:line] [--id slug]
//   node ledger.mjs validate             # exit 0 ok / 1 malformed (fails closed)
//
// State lives at $CADENCE_DIR/loop-state.json (default ./.cadence/loop-state.json).
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

const DIR = process.env.CADENCE_DIR || join(process.cwd(), '.cadence')
const FILE = join(DIR, 'loop-state.json')
const now = () => new Date().toISOString()

const SEED = () => ({
  version: 1, updated: now(), currentGoal: '', tick: 0,
  config: { recentDecisionsCap: 5, factsInlineCap: 40, factsFile: join(DIR, 'facts.jsonl') },
  pending: [], done: [], blockedOnOwner: [], verifiedFacts: [], recentDecisions: [], gates: {}
})

// ── structural validation (fails closed; no external schema lib) ───────────────
export function validate (s) {
  const errs = []
  const reqArr = ['pending', 'done', 'blockedOnOwner', 'verifiedFacts', 'recentDecisions']
  if (!s || typeof s !== 'object') return ['not an object']
  if (s.version !== 1) errs.push('version must be 1')
  if (typeof s.currentGoal !== 'string') errs.push('currentGoal must be a string')
  if (!Number.isInteger(s.tick)) errs.push('tick must be an integer')
  if (!s.gates || typeof s.gates !== 'object' || Array.isArray(s.gates)) errs.push('gates must be an object map')
  for (const k of reqArr) if (!Array.isArray(s[k])) errs.push(`${k} must be an array`)
  for (const p of s.pending || []) if (!p.id || typeof p.desc !== 'string' || typeof p.score !== 'number') errs.push(`pending item invalid: ${JSON.stringify(p).slice(0, 60)}`)
  for (const f of s.verifiedFacts || []) if (!f.id || typeof f.oneLine !== 'string') errs.push('verifiedFact item invalid')
  return errs
}

export function load () {
  if (!existsSync(FILE)) throw new Error(`no ledger at ${FILE} — run: node ledger.mjs init`)
  const s = JSON.parse(readFileSync(FILE, 'utf8'))
  const errs = validate(s)
  if (errs.length) throw new Error('ledger invalid (failing closed):\n  - ' + errs.join('\n  - '))
  return s
}

export function save (s) {
  s.updated = now()
  const errs = validate(s)
  if (errs.length) throw new Error('refusing to write invalid ledger:\n  - ' + errs.join('\n  - '))
  mkdirSync(DIR, { recursive: true })
  const tmp = FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, FILE) // atomic
}

const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'item'

// ── mutations (the only writers) ───────────────────────────────────────────────
export function addPending (s, { id, score, desc, effort, ownerGated }) {
  s.pending = s.pending.filter(p => p.id !== id)
  s.pending.push({ id, score: Number(score), desc, ...(effort && { effort }), ...(ownerGated && { ownerGated: true }) })
  return s
}
export function nextItem (s) {
  return [...s.pending].sort((a, b) => b.score - a.score)[0] || null
}
export function complete (s, id, line, sha) {
  const i = s.pending.findIndex(p => p.id === id)
  if (i === -1) throw new Error(`no pending item "${id}"`)
  s.pending.splice(i, 1)
  s.tick += 1
  s.done.push({ id, line, ...(sha && { sha }), tick: s.tick })
  return s
}
export function fail (s, id, firstError, ranBecause) {
  const p = s.pending.find(x => x.id === id)
  if (!p) throw new Error(`no pending item "${id}"`)
  s.tick += 1
  p.lastError = { firstError: String(firstError).slice(0, 500), ...(ranBecause && { ranBecause }), tick: s.tick }
  return s // item stays in pending — the failure loop is closed
}
export function block (s, id) {
  const i = s.pending.findIndex(p => p.id === id)
  if (i === -1) throw new Error(`no pending item "${id}"`)
  const [p] = s.pending.splice(i, 1)
  s.blockedOnOwner.push({ id: p.id, desc: p.desc, since: s.tick })
  return s
}
export function unblock (s, id) {
  const i = s.blockedOnOwner.findIndex(b => b.id === id)
  if (i === -1) throw new Error(`no blocked item "${id}"`)
  const [b] = s.blockedOnOwner.splice(i, 1)
  s.pending.push({ id: b.id, desc: b.desc, score: 0 }) // re-enters the single queue; rescore as needed
  return s
}
export function patchGate (s, id, pass, { firstError, ms, ranBecause } = {}) {
  s.gates[id] = { pass: !!pass, ...(firstError && { firstError: String(firstError).slice(0, 500) }), ...(ms != null && { ms: Number(ms) }), tick: s.tick, ...(ranBecause && { ranBecause }) }
  return s
}
export function addFact (s, oneLine, { pointer, id } = {}) {
  const fid = id || slug(oneLine)
  if (s.verifiedFacts.some(f => f.id === fid || f.oneLine === oneLine)) return s // dedupe
  s.verifiedFacts.push({ id: fid, oneLine: String(oneLine).slice(0, 280), ...(pointer && { pointer }) })
  const cap = s.config?.factsInlineCap ?? 40
  while (s.verifiedFacts.length > cap) {
    const old = s.verifiedFacts.shift() // page oldest one-liner out to disk; index stays bounded
    try { mkdirSync(dirname(s.config.factsFile), { recursive: true }); appendFileSync(s.config.factsFile, JSON.stringify(old) + '\n') } catch { /* best-effort paging */ }
  }
  return s
}
export function decide (s, decided, why) {
  s.recentDecisions.push({ tick: s.tick, decided, ...(why && { why }) })
  const cap = s.config?.recentDecisionsCap ?? 5
  while (s.recentDecisions.length > cap) s.recentDecisions.shift() // FIFO
  return s
}

// ── the per-tick digest (bounded view the orchestrator loads) ──────────────────
export function digest (s) {
  const top = [...s.pending].sort((a, b) => b.score - a.score).slice(0, 3)
  return [
    `goal: ${s.currentGoal || '(unset)'}   tick: ${s.tick}`,
    `next: ${top.map(p => `${p.id}(${p.score}${p.lastError ? ' ⚠retry' : ''})`).join(', ') || '(none)'}`,
    `pending: ${s.pending.length}  done: ${s.done.length}  blockedOnOwner: ${s.blockedOnOwner.length}`,
    `gates: ${Object.entries(s.gates).map(([k, g]) => `${k}=${g.pass ? '✓' : '✗'}`).join(' ') || '(none run)'}`,
    `facts(index): ${s.verifiedFacts.length}   recentDecisions: ${s.recentDecisions.length}`,
    s.blockedOnOwner.length ? `⏳ owner: ${s.blockedOnOwner.map(b => b.id).join(', ')}` : ''
  ].filter(Boolean).join('\n')
}

// ── CLI ────────────────────────────────────────────────────────────────────────
function flag (args, name) { const i = args.indexOf(name); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : undefined }
function has (args, name) { return args.includes(name) }

function main () {
  const [cmd, ...rest] = process.argv.slice(2)
  try {
    if (cmd === 'init') {
      if (existsSync(FILE)) { console.error(`ledger already exists at ${FILE} (not clobbering)`); process.exit(0) }
      const s = SEED(); s.currentGoal = flag(rest, '--goal') || ''
      save(s); console.log(`✓ initialized ${FILE}`); return
    }
    if (cmd === 'validate') { load(); console.log('✓ ledger valid'); return }
    const s = load()
    switch (cmd) {
      case 'show': console.log(digest(s)); break
      case 'next': console.log(JSON.stringify(nextItem(s), null, 2)); break
      case 'add': addPending(s, { id: rest[0], score: rest[1], desc: rest[2] || '', effort: flag(rest, '--effort'), ownerGated: has(rest, '--owner') }); save(s); console.log(`✓ added ${rest[0]}`); break
      case 'done': complete(s, rest[0], rest[1] || '', flag(rest, '--sha')); save(s); console.log(`✓ done ${rest[0]} (tick ${s.tick})`); break
      case 'fail': fail(s, rest[0], flag(rest, '--error') || 'unspecified', flag(rest, '--because')); save(s); console.log(`✓ reopened ${rest[0]} with lastError (tick ${s.tick})`); break
      case 'block': block(s, rest[0]); save(s); console.log(`✓ blocked ${rest[0]}`); break
      case 'unblock': unblock(s, rest[0]); save(s); console.log(`✓ unblocked ${rest[0]} -> pending`); break
      case 'gate': patchGate(s, rest[0], rest[1] === 'pass', { firstError: flag(rest, '--error'), ms: flag(rest, '--ms'), ranBecause: flag(rest, '--because') }); save(s); console.log(`✓ gate ${rest[0]}=${rest[1]}`); break
      case 'fact': addFact(s, rest[0], { pointer: flag(rest, '--pointer'), id: flag(rest, '--id') }); save(s); console.log('✓ fact recorded'); break
      case 'decide': decide(s, rest[0], rest[1]); save(s); console.log('✓ decision recorded'); break
      default:
        console.error('cadence ledger — verbs: init show next add done fail block unblock gate fact decide validate')
        process.exit(1)
    }
  } catch (e) { console.error('✗ ' + e.message); process.exit(1) }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
