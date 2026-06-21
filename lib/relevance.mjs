// Cadence relevance — map changed files to the minimal (conservative-superset)
// set of gates a diff can affect. Opt-in: only worth enabling when the full gate
// suite is slow. Dependency-free; pure function + helper.
import { execSync } from 'node:child_process'

// rules: [{ if: "<regex>", run: ["gateId", ...] | "ALL" }]
// Falls back to ALL gates when no rules match a file (never under-runs).
export function relevantGates (changedFiles, rules, allGateIds) {
  if (!rules || !rules.length) return [...allGateIds]
  const out = new Set()
  for (const f of changedFiles) {
    let matched = false
    for (const r of rules) {
      let re
      try { re = new RegExp(r.if) } catch { continue }
      if (re.test(f)) {
        matched = true
        if (r.run === 'ALL') return [...allGateIds] // a structural change forces the full suite
        for (const g of r.run) if (allGateIds.includes(g)) out.add(g)
      }
    }
    if (!matched) return [...allGateIds] // unknown file type → run everything (conservative)
  }
  return [...out]
}

export function changedFilesFromGit (root = process.cwd()) {
  try {
    const opt = { cwd: root, encoding: 'utf8' }
    const staged = execSync('git diff --cached --name-only', opt)
    const unstaged = execSync('git diff --name-only', opt)
    const untracked = execSync('git ls-files --others --exclude-standard', opt)
    return [...new Set((staged + unstaged + untracked).split('\n').map(s => s.trim()).filter(Boolean))]
  } catch { return [] }
}
