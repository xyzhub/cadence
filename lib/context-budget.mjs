#!/usr/bin/env node
// Cadence context budget — keep every subagent inside the first ~30% of its window
// (the high-attention region; avoids lost-in-the-middle / context rot).
//
// WHAT THIS ENFORCES (honest scope): it bounds the INPUT you hand a subagent
// (prompt + data), pre-dispatch. It does NOT bound what the agent reads at runtime
// with its own tools — that's controlled by SCOPING/decomposing the task + the
// agent's soft self-report (subagent-result.budget). See protocols/09-context-budget.md.
//
//   node context-budget.mjs budget [model]               # the numbers for a model
//   node context-budget.mjs estimate [path... | -]       # utf-8-byte / token estimate of inputs
//   node context-budget.mjs fits <model> [path... | -]   # does the input fit its cap?
//        exit 0 = fits · 1 = too big (decompose) · 2 = error/unreadable OR onExceed:abort  (FAILS CLOSED)
//
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.CADENCE_DIR || join(process.cwd(), '.cadence')
const CONFIG = process.env.CADENCE_CONFIG || join(DIR, 'cadence.config.json')

// Estimate tokens from UTF-8 BYTES (a more script-stable basis than chars: ~3-4
// bytes/token across English, code, and CJK). Conservative default; tune per project.
// NOTE: still an approximation — it can under-count dense code/JSON and CJK. The
// inputReserveFraction margin absorbs slop; lower bytesPerToken for CJK-heavy repos.
const DEFAULTS = { subagentWindowFraction: 0.30, inputReserveFraction: 0.5, bytesPerToken: 3.5, models: { default: 200000 }, onExceed: 'split' }
function loadCtx () {
  if (!existsSync(CONFIG)) return DEFAULTS
  try { const c = JSON.parse(readFileSync(CONFIG, 'utf8')).context || {}; return { ...DEFAULTS, ...c, models: { ...DEFAULTS.models, ...(c.models || {}) } } } catch { return DEFAULTS }
}
// Loud about unknown models — a typo and a real 1M-window model must not both look like 200k.
function windowFor (ctx, model) {
  const m = model || 'default'
  if (ctx.models[m] != null) return { windowTokens: ctx.models[m], warning: null }
  return { windowTokens: ctx.models.default || 200000, warning: `model "${m}" not in context.models — using default ${ctx.models.default || 200000} (add it to cadence.config.json to be exact)` }
}

export function budgetFor (model) {
  const ctx = loadCtx()
  const { windowTokens, warning } = windowFor(ctx, model)
  const budgetTokens = Math.floor(windowTokens * ctx.subagentWindowFraction)
  const inputCapTokens = Math.floor(budgetTokens * ctx.inputReserveFraction)
  return { model: model || 'default', windowTokens, warning, fraction: ctx.subagentWindowFraction, budgetTokens, inputReserveFraction: ctx.inputReserveFraction, inputCapTokens, bytesPerToken: ctx.bytesPerToken, onExceed: ctx.onExceed }
}

// Returns { tokens, bytes, unreadable:[paths] }. Reads file/stdin CONTENTS as a
// Buffer so the basis is identical (utf-8 bytes) on both paths, and so a missing
// file / directory / unreadable path throws -> recorded as unreadable (FAIL CLOSED),
// never silently counted as 0.
function estimateInput (paths, bytesPerToken) {
  let bytes = 0; const unreadable = []
  const isStdin = !paths.length || (paths.length === 1 && paths[0] === '-')
  if (isStdin) {
    try { bytes = readFileSync(0).length } catch (e) { unreadable.push('<stdin>') }
  } else {
    for (const p of paths) {
      try { bytes += readFileSync(p).length } catch (e) { unreadable.push(p) } // ENOENT / EISDIR / EACCES
    }
  }
  return { bytes, tokens: Math.ceil(bytes / bytesPerToken), unreadable }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2)
const ctx = loadCtx()

if (cmd === 'budget') {
  console.log(JSON.stringify(budgetFor(rest[0]), null, 2))
} else if (cmd === 'estimate') {
  const e = estimateInput(rest, ctx.bytesPerToken)
  console.log(JSON.stringify(e, null, 2))
  process.exit(e.unreadable.length ? 2 : 0)
} else if (cmd === 'fits') {
  const model = rest[0]
  if (!model) { console.error(JSON.stringify({ error: 'usage: fits <model> [path... | -]' })); process.exit(2) }
  const b = budgetFor(model)
  const inp = estimateInput(rest.slice(1), b.bytesPerToken)
  if (inp.unreadable.length) { // FAIL CLOSED: a gate that can't see its input must not pass
    console.log(JSON.stringify({ fits: false, reason: 'unreadable', unreadable: inp.unreadable, model, warning: b.warning }, null, 2))
    process.exit(2)
  }
  const fits = inp.tokens <= b.inputCapTokens
  console.log(JSON.stringify({ fits, model, warning: b.warning, inputTokens: inp.tokens, inputCapTokens: b.inputCapTokens, budgetTokens: b.budgetTokens, windowTokens: b.windowTokens, headroomTokens: b.inputCapTokens - inp.tokens, onExceed: b.onExceed, note: fits ? undefined : 'input exceeds cap — DECOMPOSE into smaller subtasks (fits bounds INPUT only; the agent\'s own runtime reads are not bounded here)' }, null, 2))
  // exit: 0 fits · 2 if onExceed=abort (hard stop) · 1 otherwise (doesn't fit -> decompose)
  process.exit(fits ? 0 : (b.onExceed === 'abort' ? 2 : 1))
} else {
  console.error('cadence context-budget — verbs: budget [model] | estimate [path...|-] | fits <model> [path...|-]')
  process.exit(2)
}
