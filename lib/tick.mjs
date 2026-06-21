#!/usr/bin/env node
// Cadence tick helper — a convenience that prints what a tick needs and runs the
// relevant gates. The ORCHESTRATOR (the model) drives the real tick (act/verify/
// commit per protocols/08-lifecycle.md); this just gathers the bounded inputs +
// the gate signal in one call so the loop starts from facts, not a transcript.
//
//   node tick.mjs            # digest + next item + run-gate --auto (signal only)
//   node tick.mjs --no-gate  # digest + next only
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const LIB = dirname(fileURLToPath(import.meta.url))
const node = process.execPath
const run = (script, args) => spawnSync(node, [join(LIB, script), ...args], { encoding: 'utf8' })

console.log('── ledger ──')
process.stdout.write(run('ledger.mjs', ['show']).stdout || '')
console.log('\n── next ──')
process.stdout.write(run('ledger.mjs', ['next']).stdout || '')

if (!process.argv.includes('--no-gate')) {
  console.log('\n── gates (relevant) ──')
  const g = run('run-gate.mjs', ['--auto'])
  process.stdout.write(g.stdout || g.stderr || '')
  console.log(`\n(gate exit: ${g.status})`)
}
