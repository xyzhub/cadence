#!/usr/bin/env node
// Cadence gate runner — runs a failable gate and returns a SIGNAL, never the log.
// Dependency-free Node ESM. Fails CLOSED. Timeout is enforced IN-PROCESS via
// child_process (no dependency on a `timeout` binary — absent on macOS).
//
//   node run-gate.mjs <gateId>            # run one gate -> gate-signal JSON; exit 0 pass / 1 not
//   node run-gate.mjs --auto [files...]   # relevance-pick gates (git diff if no files); run all
//   node run-gate.mjs --list              # list configured gate ids
//
// Reason field distinguishes a genuine code failure ("gate") from a config/run
// problem ("error") so a mistyped command never masquerades as a code failure.
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { relevantGates, changedFilesFromGit } from './relevance.mjs'

const DIR = process.env.CADENCE_DIR || join(process.cwd(), '.cadence')
const CONFIG = process.env.CADENCE_CONFIG || join(DIR, 'cadence.config.json')

function loadConfig () {
  if (!existsSync(CONFIG)) { console.error(JSON.stringify({ pass: false, reason: 'error', firstError: `no config at ${CONFIG}` })); process.exit(1) }
  try { return JSON.parse(readFileSync(CONFIG, 'utf8')) } catch (e) { console.error(JSON.stringify({ pass: false, reason: 'error', firstError: 'config parse: ' + e.message })); process.exit(1) }
}

const firstMatch = (text, re) => { for (const ln of text.split('\n')) if (re.test(ln)) return ln.trim(); return null }
const lastMeaningful = (text) => { const ls = text.split('\n').map(s => s.trim()).filter(Boolean); return ls[ls.length - 1] || '' }

function runOne (id, g) {
  return new Promise((resolve) => {
    const started = Date.now()
    const timeoutMs = g.timeoutMs || 600000
    let out = '', killed = false, spawnErr = null
    const child = spawn(g.cmd, { shell: true, cwd: g.cwd ? join(process.cwd(), g.cwd) : process.cwd(), env: { ...process.env, ...(g.env || {}) } })
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL') }, timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('error', e => { spawnErr = e }) // e.g. command not found
    child.on('close', (code) => {
      clearTimeout(timer)
      const ms = Date.now() - started
      const sig = { gate: id, ms, exitCode: code }
      if (killed) return resolve({ ...sig, pass: false, reason: 'error', firstError: `timed out after ${timeoutMs}ms` })
      if (spawnErr) return resolve({ ...sig, pass: false, reason: 'error', firstError: 'could not run: ' + spawnErr.message })
      // 127 = command not found, 126 = not executable -> a CONFIG/run problem, not a code failure
      if (code === 127 || code === 126) return resolve({ ...sig, pass: false, reason: 'error', firstError: (lastMeaningful(out) || `exit ${code} (command not found / not executable)`).slice(0, 500) })
      // pattern evaluation (fail-closed on bad regex -> reason:error, NOT a silent code-fail)
      let failHit = null, successOk = true
      try {
        if (g.failPattern) failHit = firstMatch(out, new RegExp(g.failPattern))
        if (g.successPattern) successOk = new RegExp(g.successPattern).test(out)
      } catch (e) {
        return resolve({ ...sig, pass: false, reason: 'error', firstError: 'bad gate pattern (config): ' + e.message })
      }
      const exitOk = code === 0
      const pass = exitOk && !failHit && successOk
      if (pass) return resolve({ ...sig, pass: true, reason: 'pass' })
      const firstError = (failHit || (!successOk && g.successPattern ? `expected /${g.successPattern}/ not found` : '') || lastMeaningful(out) || `exit ${code}`).slice(0, 500)
      resolve({ ...sig, pass: false, reason: 'gate', firstError })
    })
  })
}

async function main () {
  const args = process.argv.slice(2)
  const cfg = loadConfig()
  const gates = cfg.gates || {}
  const ids = Object.keys(gates)

  if (args[0] === '--list') { console.log(ids.join('\n')); return }

  if (args[0] === '--auto') {
    const rules = cfg.relevance?.enabled ? cfg.relevance.rules : null
    const files = args.slice(1).length ? args.slice(1) : changedFilesFromGit()
    const pick = rules ? relevantGates(files, rules, ids) : ids
    if (!pick.length) { console.log(JSON.stringify({ pass: true, ran: [], note: 'no relevant gates for diff' })); return }
    const results = []
    for (const id of pick) results.push(await runOne(id, gates[id]))
    const pass = results.every(r => r.pass)
    console.log(JSON.stringify({ pass, ran: pick, results }, null, 2))
    process.exit(pass ? 0 : 1)
  }

  const id = args[0]
  if (!id || !gates[id]) { console.error(JSON.stringify({ pass: false, reason: 'error', firstError: `unknown gate "${id}" (have: ${ids.join(', ')})` })); process.exit(1) }
  const sig = await runOne(id, gates[id])
  console.log(JSON.stringify(sig))
  process.exit(sig.pass ? 0 : 1)
}

main()
