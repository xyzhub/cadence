#!/usr/bin/env node
// Cadence self-test — pins the hand-verified edges of the core scripts so they
// can't silently regress. It exercises the scripts as REAL subprocesses (each
// only runs main() when it is the entry file and then process.exit()s, so we
// spawn — never import — to capture true exit codes + the CLI's stderr path),
// against per-test isolated temp state. Dependency-free Node ESM, no build step.
//
//   node lib/selftest.mjs        # run all checks; exit 0 = all pass, 1 = any fail
//
// It doubles as a failable gate (clean 0/1 exit) and is copied into adopted
// projects (.cadence/lib/) so an adopter can verify their own copy of the core.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { offerText, isCodegraphTool, hasCli } from './retrieval.mjs' // pure helpers — safe to import (no main/process.exit)

// Resolve siblings relative to THIS file so the harness works both in source
// lib/ and in a copied .cadence/lib/ — never via cwd. [S9]
const LIB = dirname(fileURLToPath(import.meta.url))
const NODE = process.execPath

// [M1] Scrub ambient Cadence env: a maintainer editing Cadence may have
// CADENCE_DIR / CADENCE_CONFIG exported; left in process.env they would leak
// REAL state into a child and produce a false pass (or mutate a real ledger).
delete process.env.CADENCE_DIR
delete process.env.CADENCE_CONFIG

// One temp root; per-test dirs nested under it; nuked recursively at the end so a
// mid-suite crash leaves at most one stray dir under os.tmpdir(). [N1]
const ROOT = mkdtempSync(join(tmpdir(), 'cadence-selftest-'))
let seq = 0
const work = (name) => { const d = join(ROOT, `${++seq}-${name.replace(/[^a-z0-9]+/gi, '-')}`); mkdirSync(d, { recursive: true }); return d }
const cdir = (d) => join(d, '.cadence')

// Run a core script as a subprocess.
//  - env = scrubbed process.env (keeps PATH/HOME so gate `node`/`command -v` work [M1])
//          + CADENCE_DIR -> <work>/.cadence
//  - cwd defaults to the work dir so any git shell-out (relevance/tick) is scoped
//    to the temp dir; GIT_CEILING_DIRECTORIES stops git walking ABOVE the temp root,
//    so even if os.tmpdir() sits inside a git tree we never read the real repo [M2]
//  - timeout is a watchdog so a hung child can't wedge the whole suite [N1]
function run (script, args = [], { dir, cwd, env = {}, input } = {}) {
  return spawnSync(NODE, [join(LIB, script), ...args], {
    encoding: 'utf8',
    cwd: cwd || dir || ROOT,
    env: { ...process.env, GIT_CEILING_DIRECTORIES: ROOT, ...(dir ? { CADENCE_DIR: cdir(dir) } : {}), ...env },
    input,
    timeout: 20000,
  })
}

// helpers ----------------------------------------------------------------------
const writeConfig = (d, obj) => { mkdirSync(cdir(d), { recursive: true }); writeFileSync(join(cdir(d), 'cadence.config.json'), JSON.stringify(obj, null, 2)) }
const writeRaw = (d, file, text) => { mkdirSync(cdir(d), { recursive: true }); writeFileSync(join(cdir(d), file), text) }
const readLedger = (d) => JSON.parse(readFileSync(join(cdir(d), 'loop-state.json'), 'utf8'))
const gitInit = (d) => { try { spawnSync('git', ['init', '-q'], { cwd: d }) } catch { /* git absent: changedFilesFromGit falls back to [] */ } }
// Build gate commands from the absolute node path (robust across node managers).
// Single-quote both segments for /bin/sh so the code is shell-OPAQUE — embedded $,
// backticks, etc. are never expanded (run-gate spawns with shell:true). [N3]
const shq = (s) => `'${String(s).replace(/'/g, "'\\''")}'`
const nodeCmd = (code) => `${shq(NODE)} -e ${shq(code)}`

// tiny harness -----------------------------------------------------------------
const tests = []
const skips = []
const test = (name, fn) => tests.push({ name, fn })
// register a test only when its precondition holds; otherwise record a skip with a
// reason. Used for source-only tools (e.g. adopt.mjs, which is the bootstrap and is
// NOT copied into an adopted .cadence/lib/, so its tests can't apply there).
const testIf = (cond, reason, name, fn) => { if (cond) test(name, fn); else skips.push(`${name} — SKIPPED: ${reason}`) }
const haveSibling = (f) => existsSync(join(LIB, f))
function assert (cond, msg) { if (!cond) throw new Error(msg) }
const eq = (a, b, msg) => assert(a === b, `${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
const match = (s, re, msg) => assert(re.test(s || ''), `${msg}: ${JSON.stringify(String(s || '').slice(0, 160))} !~ ${re}`)
const json = (s) => { try { return JSON.parse(s) } catch (e) { throw new Error(`expected JSON stdout, got: ${JSON.stringify(String(s || '').slice(0, 160))}`) } }

// ── A. ledger: state machine + fail-closed ────────────────────────────────────
test('ledger: fail reopens the item with lastError, clears inFlight, bumps tick', () => {
  const d = work('led-fail')
  run('ledger.mjs', ['init'], { dir: d })
  run('ledger.mjs', ['add', 't1', '5', 'do thing'], { dir: d })
  run('ledger.mjs', ['begin', 't1'], { dir: d })
  const r = run('ledger.mjs', ['fail', 't1', '--error', 'boom'], { dir: d })
  eq(r.status, 0, 'fail exit')
  const s = readLedger(d)
  const p = s.pending.find(x => x.id === 't1')
  assert(p, 'item stays in pending after fail')
  eq(p.lastError.firstError, 'boom', 'lastError.firstError carried')
  eq(s.inFlight, null, 'inFlight cleared')
  eq(s.tick, 1, 'tick bumped once (begin does not bump, fail does)')
})

test('ledger: fails closed on a corrupt-JSON ledger (exit 1, ✗)', () => {
  const d = work('led-corrupt')
  writeRaw(d, 'loop-state.json', '{ not valid json')
  const r = run('ledger.mjs', ['show'], { dir: d })
  eq(r.status, 1, 'show exit on corrupt')
  match(r.stderr, /^✗/, 'stderr leads with ✗') // [S4] do NOT match parser wording (node-version dependent)
})

test('ledger: validate fails closed on a structurally-invalid ledger', () => {
  const d = work('led-struct')
  writeRaw(d, 'loop-state.json', JSON.stringify({ version: 2 }))
  const r = run('ledger.mjs', ['validate'], { dir: d })
  eq(r.status, 1, 'validate exit')
  match(r.stderr, /ledger invalid \(failing closed\)/, 'distinctive failing-closed message') // [S4]
})

test('ledger: init→add→begin→done completes the item cleanly', () => {
  const d = work('led-happy')
  run('ledger.mjs', ['init'], { dir: d })
  run('ledger.mjs', ['add', 't1', '5', 'x'], { dir: d })
  run('ledger.mjs', ['begin', 't1'], { dir: d })
  const r = run('ledger.mjs', ['done', 't1', 'shipped'], { dir: d })
  eq(r.status, 0, 'done exit')
  const s = readLedger(d)
  eq(s.pending.length, 0, 'pending emptied')
  assert(s.done.find(x => x.id === 't1'), 'moved to done')
  eq(s.inFlight, null, 'inFlight cleared')
  eq(s.tick, 1, 'tick bumped')
})

test('ledger: block→unblock returns the item to pending at score 0', () => {
  // NOTE: pins CURRENT behavior — unblock reconstructs {id,desc,score:0} and DROPS
  // lastError (ledger.mjs:165). protocol-02 says a round-trip "carries its prior
  // context"; that holds for fail→retry but NOT block→unblock. Discrepancy filed
  // as a backlog item; this test documents the behavior so a change is deliberate.
  const d = work('led-block')
  run('ledger.mjs', ['init'], { dir: d })
  run('ledger.mjs', ['add', 't1', '7', 'x'], { dir: d })
  run('ledger.mjs', ['begin', 't1'], { dir: d })
  run('ledger.mjs', ['fail', 't1', '--error', 'priorboom'], { dir: d })
  run('ledger.mjs', ['block', 't1'], { dir: d })
  let s = readLedger(d)
  assert(s.blockedOnOwner.find(b => b.id === 't1'), 'moved to blockedOnOwner')
  eq(s.pending.length, 0, 'not pending while blocked')
  run('ledger.mjs', ['unblock', 't1'], { dir: d })
  s = readLedger(d)
  const p = s.pending.find(x => x.id === 't1')
  assert(p, 'back in pending')
  eq(p.score, 0, 'rescored to 0')
  eq(p.lastError, undefined, 'unblock clears lastError (current behavior)')
})

test('ledger: a mutation on a non-pending id errors (exit 1, ✗)', () => {
  const d = work('led-badid')
  run('ledger.mjs', ['init'], { dir: d })
  const r = run('ledger.mjs', ['fail', 'ghost', '--error', 'x'], { dir: d })
  eq(r.status, 1, 'exit')
  match(r.stderr, /no pending item/, 'message')
})

test('ledger: reconcile with nothing in flight is a no-op (exit 0)', () => {
  const d = work('led-recon-empty')
  run('ledger.mjs', ['init'], { dir: d })
  const r = run('ledger.mjs', ['reconcile', '--retry'], { dir: d })
  eq(r.status, 0, 'exit 0 (crash-recovery on a clean ledger must not error)')
  match(r.stdout, /nothing in flight/, 'message')
})

test('ledger: init on an existing ledger does not clobber (exit 0)', () => {
  const d = work('led-init2')
  run('ledger.mjs', ['init', '--goal', 'first'], { dir: d })
  run('ledger.mjs', ['add', 'keep', '3', 'x'], { dir: d })
  const r = run('ledger.mjs', ['init', '--goal', 'second'], { dir: d })
  eq(r.status, 0, 'exit 0')
  match(r.stderr, /already exists/, 'message')
  assert(readLedger(d).pending.find(p => p.id === 'keep'), 'existing state preserved')
})

test('ledger: reconcile --retry when the in-flight item is already gone just clears inFlight', () => {
  // the "completed before the crash" branch (ledger.mjs:118) — must NOT re-create a
  // phantom pending item (double-done prevention).
  const d = work('led-recon-ghost')
  run('ledger.mjs', ['init'], { dir: d })
  const s = readLedger(d)
  s.inFlight = { item: 'ghost', started: '2020-01-01T00:00:00.000Z', tick: 0 }
  writeRaw(d, 'loop-state.json', JSON.stringify(s, null, 2))
  const r = run('ledger.mjs', ['reconcile', '--retry'], { dir: d })
  eq(r.status, 0, 'exit 0')
  const s2 = readLedger(d)
  eq(s2.inFlight, null, 'inFlight cleared')
  eq(s2.pending.length, 0, 'no phantom pending item created')
})

// ── B. single-writer lock ─────────────────────────────────────────────────────
test('lock: a second owner is refused while the lock is held', () => {
  const d = work('lock-mutex')
  eq(run('ledger.mjs', ['lock', '--owner', 'A'], { dir: d }).status, 0, 'A acquires')
  const r = run('ledger.mjs', ['lock', '--owner', 'B'], { dir: d })
  eq(r.status, 1, 'B refused')
  match(r.stderr, /already locked/, 'message')
})

test('lock: a stale-by-age lock is reclaimed; a fresh one is not', () => {
  const d = work('lock-stale')
  // [S5] pin pid:null so only the age branch decides (no live-pid interference)
  writeRaw(d, 'loop.lock', JSON.stringify({ owner: 'A', pid: null, started: '2020-01-01T00:00:00.000Z' }))
  eq(run('ledger.mjs', ['lock', '--owner', 'B', '--ttl', '1'], { dir: d }).status, 0, 'stale (old) lock reclaimed')
  // negative control: a fresh lock at the default ttl is NOT stale
  writeRaw(d, 'loop.lock', JSON.stringify({ owner: 'A', pid: null, started: new Date().toISOString() }))
  eq(run('ledger.mjs', ['lock', '--owner', 'B'], { dir: d }).status, 1, 'fresh lock not reclaimed')
})

test('lock: --force reclaims a held lock', () => {
  const d = work('lock-force')
  run('ledger.mjs', ['lock', '--owner', 'A'], { dir: d })
  eq(run('ledger.mjs', ['lock', '--owner', 'B', '--force'], { dir: d }).status, 0, 'force reclaim')
})

test('lock: a lock held by a dead pid is reclaimed (supervisor-crash branch)', () => {
  const d = work('lock-deadpid')
  const deadPid = spawnSync(NODE, ['-e', '']).pid // exited synchronously → pid is dead
  writeRaw(d, 'loop.lock', JSON.stringify({ owner: 'A', pid: deadPid, started: new Date().toISOString() }))
  eq(run('ledger.mjs', ['lock', '--owner', 'B'], { dir: d }).status, 0, 'dead-pid lock reclaimed')
})

test('lock: unlock refuses a mismatched owner, allows the holder', () => {
  const d = work('lock-unlock')
  run('ledger.mjs', ['lock', '--owner', 'A'], { dir: d })
  eq(run('ledger.mjs', ['unlock', '--owner', 'B'], { dir: d }).status, 1, 'mismatch refused')
  eq(run('ledger.mjs', ['unlock', '--owner', 'A'], { dir: d }).status, 0, 'holder unlocks')
})

// ── C. run-gate: SIGNAL not logs, gate-vs-error, timeout, patterns ─────────────
// [S1] single-gate invocations throughout — never --auto — so no git dependency.
test('run-gate: a passing gate → reason "pass", exit 0', () => {
  const d = work('rg-pass')
  writeConfig(d, { project: 't', gates: { ok: { cmd: nodeCmd('') } } })
  const r = run('run-gate.mjs', ['ok'], { dir: d })
  eq(r.status, 0, 'exit')
  const sig = json(r.stdout)
  eq(sig.pass, true, 'pass'); eq(sig.reason, 'pass', 'reason')
})

test('run-gate: a failing command → reason "gate", exit 1', () => {
  const d = work('rg-gate')
  writeConfig(d, { project: 't', gates: { bad: { cmd: nodeCmd('process.exit(1)') } } })
  const r = run('run-gate.mjs', ['bad'], { dir: d })
  eq(r.status, 1, 'exit')
  eq(json(r.stdout).reason, 'gate', 'a code failure is reason "gate"')
})

test('run-gate: an unrunnable command → reason "error" (not "gate")', () => {
  const d = work('rg-error')
  writeConfig(d, { project: 't', gates: { nope: { cmd: 'definitely-not-a-real-cmd-xyz' } } })
  const r = run('run-gate.mjs', ['nope'], { dir: d })
  eq(r.status, 1, 'exit')
  eq(json(r.stdout).reason, 'error', 'a config/run problem is reason "error"') // [N2] don't over-specify exitCode/text
})

test('run-gate: a hung command is killed in-process → reason "error", "timed out"', () => {
  const d = work('rg-timeout')
  writeConfig(d, { project: 't', gates: { slow: { cmd: nodeCmd('setTimeout(()=>{},1e7)'), timeoutMs: 800 } } })
  const r = run('run-gate.mjs', ['slow'], { dir: d })
  eq(r.status, 1, 'exit')
  const sig = json(r.stdout)
  eq(sig.reason, 'error', 'reason')
  match(sig.firstError, /timed out after \d+ms/, 'firstError') // [S3] assert kind, not timing
})

test('run-gate: a missing config fails closed → reason "error", exit 1', () => {
  const d = work('rg-noconfig') // no config written
  const r = run('run-gate.mjs', ['anything'], { dir: d })
  eq(r.status, 1, 'exit')
  match(r.stderr, /"reason":"error"/, 'error signal on stderr')
})

test('run-gate: a noisy failing gate returns a BOUNDED signal, not the full log', () => {
  // [S7] the load-bearing context-firewall guarantee (protocol-03).
  const d = work('rg-bounded')
  writeConfig(d, { project: 't', gates: { noisy: { cmd: nodeCmd("console.log('X'.repeat(5000));process.exit(1)") } } })
  const r = run('run-gate.mjs', ['noisy'], { dir: d })
  eq(r.status, 1, 'exit')
  const sig = json(r.stdout)
  eq(sig.reason, 'gate', 'reason')
  assert(sig.firstError.length <= 500, `firstError bounded to <=500 (was ${sig.firstError.length})`)
  assert(!r.stdout.includes('X'.repeat(1000)), 'the full log is NOT in the signal')
})

test('run-gate: a failPattern hit on a zero-exit command → reason "gate"', () => {
  const d = work('rg-failpat')
  writeConfig(d, { project: 't', gates: { tsc: { cmd: nodeCmd("console.log('src/x.ts:10 error TS1234: bad')"), failPattern: 'error TS\\d+' } } })
  const r = run('run-gate.mjs', ['tsc'], { dir: d })
  eq(r.status, 1, 'exit')
  const sig = json(r.stdout)
  eq(sig.reason, 'gate', 'reason'); match(sig.firstError, /TS1234/, 'firstError is the matched line')
})

test('run-gate: a required successPattern not found → reason "gate"', () => {
  const d = work('rg-succpat')
  writeConfig(d, { project: 't', gates: { test: { cmd: nodeCmd("console.log('ran some stuff')"), successPattern: 'ALL PASSED' } } })
  const r = run('run-gate.mjs', ['test'], { dir: d })
  eq(r.status, 1, 'exit')
  const sig = json(r.stdout)
  eq(sig.reason, 'gate', 'reason'); match(sig.firstError, /expected .*ALL PASSED.* not found/, 'firstError')
})

test('run-gate: a bad pattern regex fails closed → reason "error"', () => {
  const d = work('rg-badre')
  writeConfig(d, { project: 't', gates: { g: { cmd: nodeCmd("console.log('hi')"), failPattern: '(' } } })
  const r = run('run-gate.mjs', ['g'], { dir: d })
  eq(r.status, 1, 'exit')
  const sig = json(r.stdout)
  eq(sig.reason, 'error', 'reason'); match(sig.firstError, /bad gate pattern/, 'firstError')
})

test('run-gate: an unknown gate id → reason "error", exit 1', () => {
  const d = work('rg-unknown')
  writeConfig(d, { project: 't', gates: { a: { cmd: nodeCmd('') } } })
  const r = run('run-gate.mjs', ['zzz'], { dir: d })
  eq(r.status, 1, 'exit')
  match(r.stderr, /"reason":"error"/, 'error signal'); match(r.stderr, /unknown gate/, 'message')
})

test('run-gate: --list prints the configured gate ids', () => {
  const d = work('rg-list')
  writeConfig(d, { project: 't', gates: { alpha: { cmd: nodeCmd('') }, beta: { cmd: nodeCmd('') } } })
  const r = run('run-gate.mjs', ['--list'], { dir: d })
  eq(r.status, 0, 'exit'); match(r.stdout, /alpha/, 'alpha'); match(r.stdout, /beta/, 'beta')
})

// ── D. context-budget: fail-closed, file==stdin, unknown model, onExceed ───────
test('context-budget: fits on a missing path fails closed → exit 2, reason "unreadable"', () => {
  const d = work('cb-missing')
  const r = run('context-budget.mjs', ['fits', 'default', join(d, 'nope.txt')], { dir: d })
  eq(r.status, 2, 'exit 2')
  const o = json(r.stdout)
  eq(o.fits, false, 'fits false'); eq(o.reason, 'unreadable', 'reason')
})

test('context-budget: estimate gives the SAME bytes/tokens for a file and identical stdin', () => {
  const d = work('cb-stdin')
  const content = 'hello world\n'
  const f = join(d, 'in.txt'); writeFileSync(f, content)
  const a = json(run('context-budget.mjs', ['estimate', f], { dir: d }).stdout)
  const b = json(run('context-budget.mjs', ['estimate', '-'], { dir: d, input: content }).stdout) // [M4] pipe real bytes
  eq(a.bytes, b.bytes, 'bytes equal'); eq(a.tokens, b.tokens, 'tokens equal')
  eq(a.bytes, Buffer.byteLength(content), 'byte count correct')
})

test('context-budget: an unknown model warns but still fits a small input (exit 0)', () => {
  const d = work('cb-unknown')
  const f = join(d, 'small.txt'); writeFileSync(f, 'hello world\n') // small → fits default 200k window
  const r = run('context-budget.mjs', ['fits', 'made-up-model', f], { dir: d })
  eq(r.status, 0, 'exit 0 (default window)')
  const o = json(r.stdout)
  eq(o.fits, true, 'fits'); match(o.warning, /not in context\.models/, 'warning')
})

test('context-budget: input over a tiny cap with onExceed=split → exit 1', () => {
  const d = work('cb-split')
  writeConfig(d, { project: 't', context: { models: { tiny: 10 }, onExceed: 'split' } })
  const f = join(d, 'in.txt'); writeFileSync(f, 'hello world\n')
  const r = run('context-budget.mjs', ['fits', 'tiny', f], { dir: d })
  eq(r.status, 1, 'exit 1 (split)')
  const o = json(r.stdout)
  eq(o.fits, false, 'fits false'); eq(o.inputCapTokens, 1, 'cap = floor(floor(10*0.30)*0.5) = 1') // [S8] assert the math
})

test('context-budget: the same over-cap input with onExceed=abort → exit 2', () => {
  const d = work('cb-abort')
  writeConfig(d, { project: 't', context: { models: { tiny: 10 }, onExceed: 'abort' } })
  const f = join(d, 'in.txt'); writeFileSync(f, 'hello world\n')
  const r = run('context-budget.mjs', ['fits', 'tiny', f], { dir: d })
  eq(r.status, 2, 'exit 2 (abort)')
  eq(json(r.stdout).fits, false, 'fits false')
})

test('context-budget: budget verb reports the cap math and warns on an unknown model', () => {
  const d = work('cb-budget')
  writeConfig(d, { project: 't', context: { models: { tiny: 10 } } })
  const known = json(run('context-budget.mjs', ['budget', 'tiny'], { dir: d }).stdout)
  eq(known.windowTokens, 10, 'window'); eq(known.budgetTokens, 3, 'budget = floor(10*0.30)'); eq(known.inputCapTokens, 1, 'cap = floor(3*0.5)')
  eq(known.warning, null, 'no warning for a known model')
  match(json(run('context-budget.mjs', ['budget', 'ghost'], { dir: d }).stdout).warning, /not in context\.models/, 'warning for unknown')
})

test('context-budget: estimate on an unreadable path → exit 2', () => {
  const d = work('cb-est-unreadable')
  const r = run('context-budget.mjs', ['estimate', join(d, 'nope.txt')], { dir: d })
  eq(r.status, 2, 'exit 2')
  assert(json(r.stdout).unreadable.length >= 1, 'path listed as unreadable')
})

// ── E. adopt: idempotency + no-clobber ─────────────────────────────────────────
const ADOPT_SRC_ONLY = 'adopt.mjs is the bootstrap tool — not copied into an adopted .cadence/lib/'
testIf(haveSibling('adopt.mjs'), ADOPT_SRC_ONLY,
  'adopt: idempotent — re-run leaves config byte-identical and a single contract marker', () => {
  const d = work('adopt')
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' })) // [S2] pinned, no scripts
  eq(run('adopt.mjs', [], { dir: d, cwd: d }).status, 0, 'first adopt exit 0')
  const cfgPath = join(cdir(d), 'cadence.config.json')
  assert(existsSync(cfgPath), 'config written')
  assert(existsSync(join(cdir(d), 'lib', 'ledger.mjs')), 'core scripts copied')
  assert(existsSync(join(cdir(d), 'lib', 'selftest.mjs')), 'selftest copied so adopters can verify their core') // [S9]
  const cfg1 = readFileSync(cfgPath, 'utf8')
  eq(run('adopt.mjs', [], { dir: d, cwd: d }).status, 0, 'second adopt exit 0')
  eq(readFileSync(cfgPath, 'utf8'), cfg1, 'config unchanged across run 2')
  eq(readFileSync(join(d, 'AGENTS.md'), 'utf8').split('<!-- cadence:start -->').length - 1, 1, 'exactly one contract marker')
})

testIf(haveSibling('adopt.mjs'), ADOPT_SRC_ONLY,
  'adopt: appends to a pre-existing AGENTS.md once and never clobbers existing config/ledger', () => {
  const d = work('adopt-existing')
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
  writeFileSync(join(d, 'AGENTS.md'), '# My project\n\nExisting guidance.\n')
  const myCfg = JSON.stringify({ project: 'mine', gates: { g: { cmd: 'true' } }, relevance: { enabled: false, rules: [] } }, null, 2)
  writeConfig(d, JSON.parse(myCfg))
  run('ledger.mjs', ['init', '--goal', 'keepme'], { dir: d })
  const led1 = readFileSync(join(cdir(d), 'loop-state.json'), 'utf8')
  eq(run('adopt.mjs', [], { dir: d, cwd: d }).status, 0, 'exit 0')
  const agents = readFileSync(join(d, 'AGENTS.md'), 'utf8')
  match(agents, /Existing guidance/, 'original content preserved')
  eq(agents.split('<!-- cadence:start -->').length - 1, 1, 'one marker appended')
  eq(readFileSync(join(cdir(d), 'cadence.config.json'), 'utf8'), myCfg, 'existing config untouched')
  eq(readFileSync(join(cdir(d), 'loop-state.json'), 'utf8'), led1, 'existing ledger untouched (run state safe)')
})

// ── F. tick: crash-safe resume (red auto-reopen vs green surface) ──────────────
// [M3] config has NO relevance block → run-gate --auto runs ALL gates for an
// empty diff, so the gate actually executes. Assert STATE + stdout markers, never
// tick's exit code (it is 0 in both branches).
test('tick: an interrupted tick with a RED gate auto-reopens the item with context', () => {
  const d = work('tick-red')
  run('ledger.mjs', ['init'], { dir: d })
  run('ledger.mjs', ['add', 't1', '5', 'x'], { dir: d })
  run('ledger.mjs', ['begin', 't1', '--step', 'act'], { dir: d })
  writeConfig(d, { project: 't', gates: { g: { cmd: nodeCmd('process.exit(1)') } } })
  gitInit(d)
  const r = run('tick.mjs', [], { dir: d, cwd: d })
  match(r.stdout, /gate RED on resume/, 'red branch taken')
  const s = readLedger(d)
  eq(s.inFlight, null, 'inFlight cleared on red')
  const p = s.pending.find(x => x.id === 't1')
  assert(p && p.lastError, 'item reopened with lastError')
  match(p.lastError.firstError, /gate red on resume/, 'lastError carries the gate context')
})

test('tick: an interrupted tick with a GREEN gate surfaces a manual choice (never auto-done)', () => {
  const d = work('tick-green')
  run('ledger.mjs', ['init'], { dir: d })
  run('ledger.mjs', ['add', 't1', '5', 'x'], { dir: d })
  run('ledger.mjs', ['begin', 't1', '--step', 'act'], { dir: d })
  writeConfig(d, { project: 't', gates: { g: { cmd: nodeCmd('') } } })
  gitInit(d)
  const r = run('tick.mjs', [], { dir: d, cwd: d })
  match(r.stdout, /gate GREEN on resume/, 'green branch surfaced')
  const s = readLedger(d)
  assert(s.inFlight && s.inFlight.item === 't1', 'inFlight retained (not auto-completed)')
  eq(s.done.length, 0, 'nothing marked done automatically')
})

// ── G. doctor: wiring health ──────────────────────────────────────────────────
test('doctor: a correctly wired .cadence reports healthy (exit 0)', () => {
  const d = work('doc-ok')
  run('ledger.mjs', ['init'], { dir: d })
  writeConfig(d, { project: 't', gates: { g: { cmd: 'echo ok', failPattern: 'error' } } }) // bin "echo" always resolvable
  const r = run('doctor.mjs', [], { dir: d })
  eq(r.status, 0, 'exit 0'); match(r.stdout, /cadence healthy/, 'healthy message')
})

test('doctor: a gate command not on PATH → exit 1', () => {
  const d = work('doc-badbin')
  run('ledger.mjs', ['init'], { dir: d })
  writeConfig(d, { project: 't', gates: { g: { cmd: 'definitely-not-a-real-cmd-xyz run' } } })
  const r = run('doctor.mjs', [], { dir: d })
  eq(r.status, 1, 'exit 1'); match(r.stderr, /not on PATH/, 'message')
})

test('doctor: a missing ledger → exit 1', () => {
  const d = work('doc-noledger')
  writeConfig(d, { project: 't', gates: { g: { cmd: 'echo ok' } } })
  const r = run('doctor.mjs', [], { dir: d })
  eq(r.status, 1, 'exit 1'); match(r.stderr, /loop-state\.json|missing/, 'message')
})

test('doctor: a missing config → exit 1', () => {
  const d = work('doc-noconfig')
  run('ledger.mjs', ['init'], { dir: d }) // ledger present, config absent
  const r = run('doctor.mjs', [], { dir: d })
  eq(r.status, 1, 'exit 1'); match(r.stderr, /cadence\.config\.json|missing/, 'message')
})

// ── H. retrieval (CodeGraph) integration — Protocol 07 ─────────────────────────
test('retrieval: offerText returns null when the repo is already indexed', () => {
  eq(offerText({ indexed: true, cli: false }), null, 'indexed → no offer')
  eq(offerText({ indexed: true, cli: true }), null, 'indexed → no offer')
})

test('retrieval: offerText offers to INSTALL the CLI when it is absent', () => {
  const t = offerText({ indexed: false, cli: false })
  match(t, /npm install -g .*codegraph/, 'install step'); match(t, /codegraph init/, 'index step')
})

test('retrieval: offerText offers to INDEX (not install) when the CLI is present but unindexed', () => {
  const t = offerText({ indexed: false, cli: true })
  match(t, /codegraph init/, 'index step'); assert(!/npm install/.test(t), 'no install step when the CLI is present')
})

testIf(haveSibling('adopt.mjs'), ADOPT_SRC_ONLY,
  'adopt: wires a retrieval block when a .codegraph/ index is present', () => {
    const d = work('adopt-codegraph')
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    mkdirSync(join(d, '.codegraph'), { recursive: true }) // simulate an indexed repo
    eq(run('adopt.mjs', [], { dir: d, cwd: d }).status, 0, 'exit 0')
    const cfg = JSON.parse(readFileSync(join(cdir(d), 'cadence.config.json'), 'utf8'))
    eq(cfg.retrieval?.tool, 'codegraph explore', 'retrieval.tool wired')
    eq(cfg.retrieval?.fallback, 'rg -n', 'retrieval.fallback wired')
  })

testIf(haveSibling('adopt.mjs'), ADOPT_SRC_ONLY,
  'adopt: offers CodeGraph and writes no retrieval block when the repo is unindexed', () => {
    const d = work('adopt-nocg')
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'p', version: '1.0.0' }))
    const r = run('adopt.mjs', [], { dir: d, cwd: d })
    eq(r.status, 0, 'exit 0')
    match(r.stdout, /CodeGraph/, 'offer printed to stdout')
    eq(JSON.parse(readFileSync(join(cdir(d), 'cadence.config.json'), 'utf8')).retrieval, undefined, 'no retrieval block when unindexed')
  })

test('doctor: a configured retrieval tool not on PATH → exit 1', () => {
  const d = work('doc-retr-bad')
  run('ledger.mjs', ['init'], { dir: d })
  writeConfig(d, { project: 't', gates: { g: { cmd: 'echo ok' } }, retrieval: { tool: 'totally-not-real-xyz explore', fallback: 'rg -n' } })
  const r = run('doctor.mjs', [], { dir: d })
  eq(r.status, 1, 'exit 1'); match(r.stderr, /retrieval tool .*not on PATH/, 'message')
})

test('doctor: a configured retrieval tool that resolves → healthy (exit 0)', () => {
  const d = work('doc-retr-ok')
  run('ledger.mjs', ['init'], { dir: d })
  writeConfig(d, { project: 't', gates: { g: { cmd: 'echo ok' } }, retrieval: { tool: 'echo explore', fallback: 'rg -n' } })
  const r = run('doctor.mjs', [], { dir: d })
  eq(r.status, 0, 'exit 0'); match(r.stdout, /retrieval/, 'retrieval check ran')
})

test('retrieval: isCodegraphTool recognizes only the codegraph tool', () => {
  assert(isCodegraphTool('codegraph explore'), 'bare codegraph')
  assert(isCodegraphTool('/usr/bin/codegraph node'), 'absolute path')
  assert(!isCodegraphTool('rg -n'), 'rg is not codegraph')
  assert(!isCodegraphTool(''), 'empty is not codegraph')
})

test('doctor: an index present but config.retrieval unset → healthy with a nudge', () => {
  const d = work('doc-retr-nudge')
  run('ledger.mjs', ['init'], { dir: d })
  writeConfig(d, { project: 't', gates: { g: { cmd: 'echo ok' } } }) // no retrieval block
  mkdirSync(join(d, '.codegraph'), { recursive: true }) // .codegraph lives at the project root (parent of CADENCE_DIR)
  const r = run('doctor.mjs', [], { dir: d })
  eq(r.status, 0, 'exit 0 (optional accelerator, not a failure)')
  match(r.stdout, /config\.retrieval is unset/, 'nudge to wire the config')
})

// These need the real `codegraph` on PATH; skip cleanly if it isn't installed.
testIf(hasCli(), 'codegraph CLI not installed',
  'doctor: codegraph configured but no .codegraph/ index → exit 1', () => {
    const d = work('doc-cg-noindex')
    run('ledger.mjs', ['init'], { dir: d })
    writeConfig(d, { project: 't', gates: { g: { cmd: 'echo ok' } }, retrieval: { tool: 'codegraph explore', fallback: 'rg -n' } })
    const r = run('doctor.mjs', [], { dir: d })
    eq(r.status, 1, 'exit 1'); match(r.stderr, /no \.codegraph\/ index|codegraph init/, 'index-missing message')
  })

testIf(hasCli(), 'codegraph CLI not installed',
  'doctor: codegraph configured WITH a .codegraph/ index → healthy (exit 0)', () => {
    const d = work('doc-cg-ok')
    run('ledger.mjs', ['init'], { dir: d })
    writeConfig(d, { project: 't', gates: { g: { cmd: 'echo ok' } }, retrieval: { tool: 'codegraph explore', fallback: 'rg -n' } })
    mkdirSync(join(d, '.codegraph'), { recursive: true })
    const r = run('doctor.mjs', [], { dir: d })
    eq(r.status, 0, 'exit 0'); match(r.stdout, /retrieval .*codegraph/, 'codegraph retrieval ok')
  })

// ── run ───────────────────────────────────────────────────────────────────────
let passed = 0; let failed = 0
try {
  for (const t of tests) {
    try { t.fn(); passed++; console.log(`  ✓ ${t.name}`) }
    catch (e) { failed++; console.log(`  ✗ ${t.name}\n      ${e.message}`) }
  }
} finally {
  try { rmSync(ROOT, { recursive: true, force: true }) } catch { /* best-effort */ }
}
for (const s of skips) console.log(`  ⊘ ${s}`)
const skipNote = skips.length ? `, ${skips.length} skipped` : ''
console.log(`\ncadence selftest: ${passed} passed, ${failed} failed${skipNote}  (${tests.length} run)`)
process.exit(failed ? 1 : 0)
