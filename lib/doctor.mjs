#!/usr/bin/env node
// Cadence doctor — verify a target is correctly wired before running the loop.
// Checks: config present + structurally valid; ledger valid; each gate's command
// binary resolvable. Exit 0 healthy / 1 problems. Dependency-free.
//
//   node doctor.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { validate } from './ledger.mjs'

const DIR = process.env.CADENCE_DIR || join(process.cwd(), '.cadence')
const problems = []; const ok = []

// config
const cfgPath = join(DIR, 'cadence.config.json')
let cfg = null
if (!existsSync(cfgPath)) problems.push(`missing ${cfgPath} (run adopt.mjs)`)
else {
  try {
    cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    if (!cfg.project) problems.push('config: missing "project"')
    if (!cfg.gates || !Object.keys(cfg.gates).length) problems.push('config: no gates declared')
    else for (const [id, g] of Object.entries(cfg.gates)) {
      if (!g.cmd) problems.push(`gate "${id}": missing cmd`)
      else {
        const bin = g.cmd.trim().split(/\s+/)[0]
        try { execSync(`command -v ${bin}`, { stdio: 'ignore', shell: '/bin/sh' }); ok.push(`gate "${id}" -> ${bin} ✓`) }
        catch { problems.push(`gate "${id}": command "${bin}" not on PATH`) }
      }
      if (g.failPattern) { try { new RegExp(g.failPattern) } catch (e) { problems.push(`gate "${id}": bad failPattern — ${e.message}`) } }
    }
  } catch (e) { problems.push('config: invalid JSON — ' + e.message) }
}

// ledger
const ledPath = join(DIR, 'loop-state.json')
if (!existsSync(ledPath)) problems.push(`missing ${ledPath} (run adopt.mjs)`)
else {
  try { const errs = validate(JSON.parse(readFileSync(ledPath, 'utf8'))); if (errs.length) problems.push('ledger invalid:\n    - ' + errs.join('\n    - ')); else ok.push('ledger valid ✓') }
  catch (e) { problems.push('ledger: ' + e.message) }
}

ok.forEach(o => console.log('  ' + o))
if (problems.length) { console.error('\n✗ cadence doctor found problems:\n  - ' + problems.join('\n  - ')); process.exit(1) }
console.log('\n✓ cadence healthy' + (cfg ? ` — ${Object.keys(cfg.gates).length} gate(s) for "${cfg.project}"` : ''))
