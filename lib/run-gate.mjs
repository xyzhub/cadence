#!/usr/bin/env node
// Cadence gate runner — runs a failable gate and returns a SIGNAL, never the log.
// Dependency-free Node ESM. Fails CLOSED. Timeout is enforced IN-PROCESS via
// child_process (no dependency on a `timeout` binary — absent on macOS): on timeout
// it SIGKILLs the whole process group and resolves immediately, so a hung command
// whose grandchildren survive can't wedge the runner.
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
    let out = '', killed = false, spawnErr = null, settled = false
    // detached -> the shell becomes a process-GROUP leader, so on timeout we can SIGKILL
    // the whole group (shell + any grandchildren). A bare child.kill() signals only the
    // shell; a surviving grandchild keeps the stdout pipe open so 'close' never fires and
    // a close-only resolver would hang forever. [run-gate timeout bug]
    const child = spawn(g.cmd, { shell: true, detached: true, cwd: g.cwd ? join(process.cwd(), g.cwd) : process.cwd(), env: { ...process.env, ...(g.env || {}) } })
    // The ONE resolve path: idempotent (settled guard), clears the timer, and frees our
    // stdio handles so a lingering orphan can't keep the event loop alive.
    const finish = (sig) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.stdout?.destroy() } catch { /* already gone */ }
      try { child.stderr?.destroy() } catch { /* already gone */ }
      try { child.unref() } catch { /* already gone */ }
      resolve(sig)
    }
    const timer = setTimeout(() => {
      killed = true
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL') } catch { /* group gone */ } // -pid = the whole group
      try { child.kill('SIGKILL') } catch { /* already gone */ }                            // belt-and-suspenders
      // Resolve NOW — never wait for 'close', which may never arrive if a grandchild lingers.
      finish({ gate: id, ms: Date.now() - started, exitCode: null, pass: false, reason: 'error', firstError: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    child.on('error', e => { spawnErr = e; finish({ gate: id, ms: Date.now() - started, exitCode: null, pass: false, reason: 'error', firstError: 'could not run: ' + e.message }) }) // e.g. command not found
    child.on('close', (code) => {
      const ms = Date.now() - started
      const sig = { gate: id, ms, exitCode: code }
      if (killed) return finish({ ...sig, pass: false, reason: 'error', firstError: `timed out after ${timeoutMs}ms` })
      if (spawnErr) return finish({ ...sig, pass: false, reason: 'error', firstError: 'could not run: ' + spawnErr.message })
      // 127 = command not found, 126 = not executable -> a CONFIG/run problem, not a code failure
      if (code === 127 || code === 126) return finish({ ...sig, pass: false, reason: 'error', firstError: (lastMeaningful(out) || `exit ${code} (command not found / not executable)`).slice(0, 500) })
      // pattern evaluation (fail-closed on bad regex -> reason:error, NOT a silent code-fail)
      let failHit = null, successOk = true
      try {
        if (g.failPattern) failHit = firstMatch(out, new RegExp(g.failPattern))
        if (g.successPattern) successOk = new RegExp(g.successPattern).test(out)
      } catch (e) {
        return finish({ ...sig, pass: false, reason: 'error', firstError: 'bad gate pattern (config): ' + e.message })
      }
      const exitOk = code === 0
      const pass = exitOk && !failHit && successOk
      if (pass) return finish({ ...sig, pass: true, reason: 'pass' })
      const firstError = (failHit || (!successOk && g.successPattern ? `expected /${g.successPattern}/ not found` : '') || lastMeaningful(out) || `exit ${code}`).slice(0, 500)
      finish({ ...sig, pass: false, reason: 'gate', firstError })
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
