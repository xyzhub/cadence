#!/usr/bin/env node
// Cadence tick helper — gathers the bounded inputs a tick needs AND auto-handles
// an interrupted (crashed) tick before proceeding. The ORCHESTRATOR still drives
// the real tick (act/verify/commit, protocols/08-lifecycle.md); this de-risks
// resume: a crash mid-tick can never leave the loop stuck or silently desynced.
//
//   node tick.mjs            # reconcile if needed, then digest + next + relevant gates
//   node tick.mjs --no-gate  # skip the gate run
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = dirname(fileURLToPath(import.meta.url))
const run = (script, args = []) => spawnSync(process.execPath, [join(LIB, script), ...args], { encoding: 'utf8' })
const firstGateError = (autoStdout) => {
  try { const r = JSON.parse(autoStdout); return (r.results || []).find(x => !x.pass)?.firstError || 'gate failed' } catch { return 'gate failed' }
}

// ── reconcile an interrupted tick (intent journal survived a crash) ───────────
let gatesRan = false
let inflight = null
try { inflight = JSON.parse((run('ledger.mjs', ['inflight']).stdout || 'null').trim() || 'null') } catch { inflight = null }

if (inflight) {
  console.log(`⚠ INTERRUPTED TICK on "${inflight.item}"${inflight.step ? ' @ ' + inflight.step : ''} (since ${inflight.started}) — reconciling…`)
  const g = run('run-gate.mjs', ['--auto']); gatesRan = true
  const pass = g.status === 0
  if (pass) {
    // ambiguous: green could mean the work completed before the crash. Do NOT auto-complete
    // (that risks a false "done"); surface the safe choices to the orchestrator.
    console.log('  gate GREEN on resume — the change may already have landed. VERIFY it (git log / the artifact), then:')
    console.log(`    node .cadence/lib/ledger.mjs reconcile --done "<what shipped>"    # if confirmed complete`)
    console.log(`    node .cadence/lib/ledger.mjs reconcile --retry --error "re-do"    # if not`)
  } else {
    // unambiguous: red means it isn't done/correct -> auto-reopen with context (safe + automatic).
    const r = run('ledger.mjs', ['reconcile', '--retry', '--error', `interrupted${inflight.step ? ' at ' + inflight.step : ''}; gate red on resume: ${firstGateError(g.stdout)}`])
    console.log('  gate RED on resume — auto-reopened the item with context (safe). ' + (r.stdout || '').trim())
  }
  console.log('')
}

console.log('── ledger ──')
process.stdout.write(run('ledger.mjs', ['show']).stdout || '')
console.log('\n── next ──')
process.stdout.write(run('ledger.mjs', ['next']).stdout || '')

if (!gatesRan && !process.argv.includes('--no-gate')) {
  console.log('\n── gates (relevant) ──')
  const g = run('run-gate.mjs', ['--auto'])
  process.stdout.write(g.stdout || g.stderr || '')
  console.log(`\n(gate exit: ${g.status})`)
}
