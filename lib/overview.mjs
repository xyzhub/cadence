#!/usr/bin/env node
// Cadence overview — render the ledger as a self-contained, dependency-free HTML page
// you open in a browser to see the loop's progress + changes at a glance. One source of
// truth (loop-state.json) -> one offline HTML file (no JS deps, no external assets, no
// build). Regenerate it each tick or on demand. Inspired by anthropics/launch-your-agent's
// agent-overview.html, but rendered DETERMINISTICALLY by a script (Cadence's ethos), not
// hand-written by an LLM — so it's free to refresh every tick.
//
//   node overview.mjs              # write $CADENCE_DIR/cadence-overview.html
//   node overview.mjs -o <path>    # write to a custom path (absolute or cwd-relative)
//   node overview.mjs --stdout     # print the HTML to stdout instead of a file
//   node overview.mjs --open       # also open it in the default browser
//
import { writeFileSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { spawn } from 'node:child_process'
import { load } from './ledger.mjs' // fails-closed read+validate of $CADENCE_DIR/loop-state.json

const DIR = process.env.CADENCE_DIR || join(process.cwd(), '.cadence')

// ── helpers ───────────────────────────────────────────────────────────────────
const ESCS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ESCS[c]) // every dynamic string passes through here
const n = (a) => Array.isArray(a) ? a.length : 0
const tickSet = (items, pick) => new Set(items.flatMap(x => { const t = pick(x); return t == null ? [] : [t] }))

// status lifecycle, derived purely from the ledger (every pixel is backed by a field)
function status (s) {
  if (s.inFlight) return { label: 'INTERRUPTED', cls: 'st-int', note: 'a tick is mid-flight — reconcile' }
  if (n(s.pending) === 0 && n(s.blockedOnOwner) > 0) return { label: 'BLOCKED', cls: 'st-block', note: 'all remaining work waits on the owner' }
  if (n(s.pending) === 0) return { label: 'IDLE', cls: 'st-idle', note: 'no pending work' }
  return { label: 'RUNNING', cls: 'st-run', note: `${n(s.pending)} item(s) queued` }
}

// ── the signature: the cadence rail (a beat per tick, colored by outcome) ───────
const RAIL_CAP = 240 // cap rendered beats; a long loop's earlier ticks collapse to a "+N" chip
function rail (s) {
  const green = tickSet(s.done, d => d.tick)
  const red = tickSet([...(s.pending || []), ...(s.blockedOnOwner || [])], p => p.lastError?.tick)
  const cur = s.tick
  if (cur < 1) return '<div class="rail"><div class="rail-empty">no ticks yet — the loop hasn\'t run. Beats appear here as it progresses.</div></div>'
  const from = Math.max(1, cur - RAIL_CAP + 1)
  const beats = []
  if (from > 1) beats.push(`<span class="rail-more" title="${from - 1} earlier tick(s) not shown">+${from - 1}</span>`)
  for (let t = from; t <= cur; t++) {
    let cls = 'b-noop'; let title = `tick ${t}` // a tick with no shipped/failed item reads as a quiet beat
    if (green.has(t)) { cls = 'b-done'; title = `tick ${t}: shipped` }
    else if (red.has(t)) { cls = 'b-fail'; title = `tick ${t}: gate red` }
    const live = (t === cur && s.inFlight) ? ' b-live' : ''
    beats.push(`<i class="beat ${cls}${live}" title="${esc(title)}"></i>`)
  }
  const legend = '<span class="lg"><i class="beat b-done"></i>shipped</span><span class="lg"><i class="beat b-fail"></i>gate red</span><span class="lg"><i class="beat b-noop"></i>no-op</span>'
  return `<div class="rail"><div class="rail-track">${beats.join('')}</div><div class="rail-foot"><span class="rail-label">cadence · ${cur} tick${cur === 1 ? '' : 's'}</span>${legend}</div></div>`
}

const chip = (txt, cls = '') => `<span class="chip ${cls}">${esc(txt)}</span>`
const retry = (p) => p.lastError ? `<span class="chip warn" title="${esc(p.lastError.firstError)}">⚠ retry · t${esc(p.lastError.tick)}</span>` : ''

function pendingLane (s) {
  const items = [...(s.pending || [])].sort((a, b) => b.score - a.score)
  if (!items.length) return emptyCard('pending queue', 'queue empty — nothing to do (the loop pauses here).')
  const rows = items.map((p, i) => `
    <div class="item${i === 0 ? ' top' : ''}">
      <div class="item-h"><span class="score" title="value ÷ effort">${esc(p.score)}</span><span class="iid">${esc(p.id)}</span>${retry(p)}</div>
      <div class="item-d">${esc(p.desc)}</div>
      <div class="item-m">${p.gate ? chip('gate · ' + p.gate, 'gate') : ''}${p.phase ? chip('phase · ' + p.phase) : ''}${p.effort ? chip(p.effort) : ''}${p.brief ? chip('brief', 'brief') : ''}</div>
      ${p.accept ? `<div class="accept">✓ ${esc(p.accept)}</div>` : ''}
    </div>`).join('')
  return card('pending queue', `${items.length} scored`, rows)
}

function doneLane (s) {
  const items = [...(s.done || [])].sort((a, b) => (b.tick || 0) - (a.tick || 0))
  if (!items.length) return emptyCard('shipped', 'no items shipped yet — the first green tick fills this in.')
  const rows = items.map(d => `
    <div class="row">
      <span class="rtick">t${esc(d.tick)}</span>
      <span class="rline">${esc(d.line)}</span>
      ${d.sha ? `<span class="sha">${esc(d.sha)}</span>` : ''}
    </div>`).join('')
  return card('shipped · done', `${items.length}`, rows)
}

function blockedLane (s) {
  const items = s.blockedOnOwner || []
  if (!items.length) return emptyCard('blocked on owner', 'nothing waiting on a human decision.')
  const rows = items.map(b => `
    <div class="row blocked">
      <span class="rid">${esc(b.id)}</span>
      <span class="rline">${esc(b.desc)}</span>
      ${b.since != null ? `<span class="since">since t${esc(b.since)}</span>` : ''}
      ${b.lastError ? `<span class="chip warn" title="${esc(b.lastError.firstError)}">⚠ ctx kept</span>` : ''}
    </div>`).join('')
  return card('⏳ blocked on owner', `${items.length}`, rows, 'lane-block')
}

function gatesLane (s) {
  const ids = Object.keys(s.gates || {})
  if (!ids.length) return emptyCard('gate signals', 'no gates run yet — a tick records pass/fail here.')
  const rows = ids.map(id => {
    const g = s.gates[id]
    return `<div class="grow">
      <span class="gled ${g.pass ? 'ok' : 'no'}"></span>
      <span class="gid">${esc(id)}</span>
      <span class="gv">${g.pass ? 'pass' : 'fail'}</span>
      ${g.ms != null ? `<span class="gms">${esc(g.ms)}ms</span>` : ''}
      ${(!g.pass && g.firstError) ? `<span class="gerr" title="${esc(g.firstError)}">${esc(g.firstError)}</span>` : ''}
    </div>`
  }).join('')
  const passing = ids.filter(id => s.gates[id].pass).length
  return card('gate signals', `${passing}/${ids.length} green`, rows)
}

function inflightCard (s) {
  if (!s.inFlight) return ''
  const f = s.inFlight
  return `<div class="card lane-flight">
    <div class="card-h"><span class="card-t"><span class="pulse"></span> in-flight</span><span class="card-c">tick ${esc(f.tick)}</span></div>
    <div class="card-b"><div class="flight">
      <span class="iid">${esc(f.item)}</span>${f.step ? chip('@ ' + f.step, 'gate') : ''}
      <div class="item-m">started ${esc(f.started)}</div>
    </div></div></div>`
}

function knowledgeLane (s) {
  const facts = s.verifiedFacts || []; const decs = s.recentDecisions || []
  const factHtml = facts.length
    ? facts.map(f => `<div class="krow"><span class="kdot"></span><span class="ktxt">${esc(f.oneLine)}</span>${f.pointer ? `<span class="kptr">${esc(f.pointer)}</span>` : ''}</div>`).join('')
    : '<div class="kempty">no verified facts yet.</div>'
  const decHtml = decs.length
    ? [...decs].reverse().map(d => `<div class="krow"><span class="ktick">t${esc(d.tick)}</span><span class="ktxt">${esc(d.decided)}${d.why ? ` <span class="kwhy">— ${esc(d.why)}</span>` : ''}</span></div>`).join('')
    : '<div class="kempty">no decisions recorded yet.</div>'
  return `<div class="card span2"><div class="card-h"><span class="card-t">verified facts</span><span class="card-c">${facts.length} index</span></div><div class="card-b">${factHtml}</div></div>
  <div class="card span2"><div class="card-h"><span class="card-t">recent decisions</span><span class="card-c">${decs.length}</span></div><div class="card-b">${decHtml}</div></div>`
}

const card = (title, count, body, extra = '') => `<div class="card ${extra}"><div class="card-h"><span class="card-t">${esc(title)}</span><span class="card-c">${esc(count)}</span></div><div class="card-b">${body}</div></div>`
const emptyCard = (title, msg) => `<div class="card"><div class="card-h"><span class="card-t">${esc(title)}</span></div><div class="card-b"><div class="empty">${esc(msg)}</div></div></div>`

// ── the document ────────────────────────────────────────────────────────────────
function render (s) {
  const st = status(s)
  const passing = Object.values(s.gates || {}).filter(g => g.pass).length
  const gateTotal = n(Object.keys(s.gates || {}))
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cadence · overview${s.currentGoal ? ' · ' + esc(s.currentGoal.slice(0, 60)) : ''}</title>
<style>
:root{
  --bg:#0e1118;--panel:#151b26;--panel2:#1a2130;--line:#262e3d;--line2:#323c4f;
  --text:#e7ebf3;--dim:#8a93a8;--faint:#828ea6;
  --beat:#8b7bff;--pass:#3ad29f;--fail:#ff6b6b;--block:#f6b13d;--inflight:#46b1ff;
  --mono:ui-monospace,'SF Mono','JetBrains Mono',Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
}
*{box-sizing:border-box}
html{color-scheme:dark}
body{margin:0;background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;line-height:1.45;
  -webkit-font-smoothing:antialiased;
  background-image:radial-gradient(900px 400px at 80% -10%, rgba(139,123,255,.07), transparent 60%);}
.wrap{max-width:1180px;margin:0 auto;padding:22px 20px 60px}
.mono{font-family:var(--mono)}
/* header */
.bar{display:grid;grid-template-columns:auto 1fr auto;gap:14px 18px;align-items:center;
  padding:14px 18px;border:1px solid var(--line);border-radius:14px;background:linear-gradient(180deg,var(--panel2),var(--panel));}
.id{font-weight:800;letter-spacing:-.02em;font-size:18px;display:flex;align-items:center;gap:8px}
.id .mk{color:var(--beat)}
.id .ver{font-weight:500;color:var(--dim);font-size:12px;letter-spacing:.04em;text-transform:uppercase}
.goal{color:var(--text);font-size:14px;min-width:0;opacity:.92}
.goal .lab{color:var(--faint);text-transform:uppercase;letter-spacing:.08em;font-size:10px;margin-right:8px}
.status{display:inline-flex;align-items:center;gap:8px;font-family:var(--mono);font-size:12px;font-weight:600;
  letter-spacing:.06em;padding:6px 11px;border-radius:999px;border:1px solid var(--line2);white-space:nowrap}
.status .led{width:8px;height:8px;border-radius:50%;background:currentColor;box-shadow:0 0 0 0 currentColor}
.st-run{color:var(--pass)} .st-block{color:var(--block)} .st-int{color:var(--fail)} .st-idle{color:var(--dim)}
.st-run .led,.st-int .led{animation:pulse 1.8s ease-out infinite}
.stats{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:6px 16px;font-family:var(--mono);font-size:12px;color:var(--dim);
  border-top:1px solid var(--line);padding-top:11px;margin-top:2px}
.stats b{color:var(--text);font-weight:600}
/* the cadence rail (signature) */
.rail{margin:16px 0 20px;padding:16px 18px;border:1px solid var(--line);border-radius:14px;background:var(--panel)}
.rail-track{display:flex;align-items:flex-end;gap:6px;height:54px;overflow-x:auto;padding-bottom:2px}
.rail-more{align-self:center;font-family:var(--mono);font-size:11px;color:var(--dim);margin-right:4px;flex:0 0 auto}
.beat{flex:0 0 auto;width:11px;height:20px;border-radius:3px;background:var(--faint);opacity:.85}
.beat.b-done{height:46px;background:var(--pass);box-shadow:0 0 12px rgba(58,210,159,.25)} .beat.b-fail{height:36px;background:var(--fail)}
.beat.b-noop{height:16px;background:#4a566b}
.beat.b-live{animation:beat 1.4s ease-in-out infinite;box-shadow:0 0 10px var(--beat)}
.rail-empty{color:var(--dim);font-size:13px;padding:6px 0}
.rail-foot{display:flex;flex-wrap:wrap;align-items:center;gap:6px 16px;margin-top:12px;
  font-family:var(--mono);font-size:11px;color:var(--faint)}
.rail-label{color:var(--beat);font-weight:600;letter-spacing:.05em}
.lg{display:inline-flex;align-items:center;gap:6px} .lg .beat{width:8px;height:12px}
/* grid */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
.card{border:1px solid var(--line);border-radius:12px;background:var(--panel);overflow:hidden}
.card.span2{grid-column:1/-1}
.card-h{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:11px 14px;border-bottom:1px solid var(--line);background:rgba(255,255,255,.012)}
.card-t{font-weight:700;letter-spacing:-.01em;font-size:13px}
.card-c{font-family:var(--mono);font-size:11px;color:var(--dim)}
.card-b{padding:10px 14px;display:flex;flex-direction:column;gap:8px}
.empty{color:var(--faint);font-size:13px;font-style:italic;padding:6px 0}
/* pending items */
.item{border:1px solid var(--line);border-radius:10px;padding:10px 12px;background:var(--panel2)}
.item.top{border-color:var(--beat);box-shadow:inset 3px 0 0 var(--beat)}
.item-h{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.score{font-family:var(--mono);font-weight:700;color:var(--beat);font-size:15px;min-width:20px}
.iid{font-family:var(--mono);font-size:13px;color:var(--text);font-weight:600}
.item-d{color:var(--dim);font-size:13px;margin-top:5px}
.item-m{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}
.accept{margin-top:7px;font-size:12px;color:var(--pass);opacity:.85;font-family:var(--mono)}
.chip{font-family:var(--mono);font-size:11px;color:var(--dim);border:1px solid var(--line2);border-radius:6px;padding:2px 7px;white-space:nowrap}
.chip.gate{color:var(--inflight);border-color:rgba(70,177,255,.35)}
.chip.brief{color:var(--beat);border-color:rgba(139,123,255,.4)}
.chip.warn{color:var(--block);border-color:rgba(246,177,61,.4)}
/* rows (done / blocked / gates) */
.row{display:flex;align-items:baseline;gap:10px;font-size:13px;padding:5px 0;border-bottom:1px dashed var(--line)}
.row:last-child{border-bottom:0}
.rtick,.since,.rid{font-family:var(--mono);font-size:11px;color:var(--faint);flex:0 0 auto}
.rid{color:var(--block)} .rline{color:var(--text);min-width:0;flex:1} .row.blocked .rline{color:var(--dim)}
.sha{font-family:var(--mono);font-size:11px;color:var(--pass);flex:0 0 auto}
.grow{display:flex;align-items:center;gap:9px;padding:5px 0;border-bottom:1px dashed var(--line);font-size:13px}
.grow:last-child{border-bottom:0}
.gled{width:9px;height:9px;border-radius:50%;flex:0 0 auto}.gled.ok{background:var(--pass);box-shadow:0 0 7px rgba(58,210,159,.6)}.gled.no{background:var(--fail);box-shadow:0 0 7px rgba(255,107,107,.6)}
.gid{font-family:var(--mono);font-weight:600}.gv{font-family:var(--mono);font-size:11px;color:var(--dim)}
.gms{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:auto}
.gerr{font-family:var(--mono);font-size:11px;color:var(--fail);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%}
.lane-block{border-color:rgba(246,177,61,.28)} .lane-flight{border-color:var(--inflight);grid-column:1/-1}
.flight{display:flex;align-items:center;gap:9px;flex-wrap:wrap}
.pulse{width:8px;height:8px;border-radius:50%;background:var(--inflight);display:inline-block;animation:pulse 1.6s infinite;color:var(--inflight)}
/* knowledge */
.krow{display:flex;gap:9px;align-items:baseline;padding:4px 0;font-size:13px}
.kdot{width:5px;height:5px;border-radius:50%;background:var(--beat);flex:0 0 auto;margin-top:7px;opacity:.7}
.ktick{font-family:var(--mono);font-size:11px;color:var(--faint);flex:0 0 auto}
.ktxt{color:var(--text);min-width:0}.kwhy{color:var(--dim)}
.kptr{font-family:var(--mono);font-size:11px;color:var(--faint);margin-left:auto;flex:0 0 auto}
.kempty{color:var(--faint);font-style:italic;font-size:13px}
/* footer */
.foot{margin-top:22px;padding-top:14px;border-top:1px solid var(--line);font-family:var(--mono);font-size:11px;color:var(--faint);
  display:flex;flex-wrap:wrap;gap:6px 16px;justify-content:space-between}
.goal,.rline,.item-d,.ktxt{overflow-wrap:anywhere} /* break a pathological spaceless token instead of overflowing */
@keyframes pulse{0%{box-shadow:0 0 0 0 currentColor}70%{box-shadow:0 0 0 6px transparent}100%{box-shadow:0 0 0 0 transparent}}
@keyframes beat{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.15)}}
@media (max-width:820px){.grid{grid-template-columns:1fr}.bar{grid-template-columns:1fr}.status{justify-self:start}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style></head>
<body><div class="wrap">
  <header class="bar">
    <div class="id"><span class="mk">▦</span> cadence <span class="ver">overview</span></div>
    <div class="goal"><span class="lab">goal</span>${s.currentGoal ? esc(s.currentGoal) : '<span style="color:var(--faint)">(unset)</span>'}</div>
    <div class="status ${st.cls}" title="${esc(st.note)}"><span class="led"></span>${esc(st.label)}</div>
    <div class="stats"><span>tick <b>${esc(s.tick)}</b></span><span><b>${n(s.pending)}</b> pending</span><span><b>${n(s.done)}</b> done</span><span><b>${n(s.blockedOnOwner)}</b> blocked</span><span>gates <b>${passing}/${gateTotal}</b></span><span><b>${n(s.verifiedFacts)}</b> facts</span></div>
  </header>
  ${rail(s)}
  <div class="grid">
    ${inflightCard(s)}
    ${pendingLane(s)}
    <div class="card-stack" style="display:flex;flex-direction:column;gap:14px">
      ${gatesLane(s)}
      ${doneLane(s)}
      ${blockedLane(s)}
    </div>
    ${knowledgeLane(s)}
  </div>
  <footer class="foot"><span>generated from .cadence/loop-state.json · cadence overview</span><span>tick ${esc(s.tick)} · updated ${esc(s.updated || '—')}</span></footer>
</div></body></html>`
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const flag = (nm) => { const i = args.indexOf(nm); return i !== -1 && args[i + 1] && !args[i + 1].startsWith('-') ? args[i + 1] : undefined }
const hasOut = args.includes('-o') || args.includes('--out')
const outArg = flag('-o') || flag('--out')
if (hasOut && !outArg) { console.error('✗ -o/--out requires a path'); process.exit(2) }
let s
try { s = load() } catch (e) { console.error('✗ ' + e.message); process.exit(1) }
const html = render(s)

if (args.includes('--stdout')) { process.stdout.write(html) } else {
  const out = outArg ? (isAbsolute(outArg) ? outArg : join(process.cwd(), outArg)) : join(DIR, 'cadence-overview.html')
  try { writeFileSync(out, html) } catch (e) { console.error('✗ ' + e.message); process.exit(1) }
  console.log(`✓ wrote ${out}`)
  if (args.includes('--open')) {
    // a missing opener surfaces as an async 'error' event, NOT a sync throw — a try/catch can't
    // catch it, so attach a handler or an unhandled 'error' crashes the process after the write.
    try {
      const c = process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', out], { detached: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [out], { detached: true, stdio: 'ignore' })
      c.on('error', () => {}) // opener absent → no-op
      c.unref()
    } catch { /* best-effort */ }
  }
}

export { render }
