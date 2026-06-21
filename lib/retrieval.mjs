// Cadence retrieval — detect a code-intelligence index (CodeGraph) and, when it's
// absent, craft a concrete offer to install/index it. Retrieval-first (Protocol 07)
// makes the context firewall cheaper: one query returns the relevant symbols' source
// + call paths instead of whole-file reads. This is the ONE place that knows about
// CodeGraph specifically; the rest of Cadence treats `retrieval` as a generic
// { tool, fallback } slot, so swapping in another tool is a config edit, not a code change.
// Dependency-free Node ESM. POSIX shell assumed (same as doctor.mjs).
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const PKG = '@colbymchenry/codegraph'
export const RETRIEVAL_TOOL = 'codegraph explore'
export const RETRIEVAL_FALLBACK = 'rg -n'

// A repo is "indexed" when CodeGraph has written its graph to <root>/.codegraph/.
export function hasIndex (root = process.cwd()) { return existsSync(join(root, '.codegraph')) }
// The CLI is "installed" when `codegraph` resolves on PATH.
export function hasCli () { try { execSync('command -v codegraph', { stdio: 'ignore', shell: '/bin/sh' }); return true } catch { return false } }

export function detect (root = process.cwd()) { return { indexed: hasIndex(root), cli: hasCli(), tool: RETRIEVAL_TOOL, fallback: RETRIEVAL_FALLBACK } }

// True when the configured retrieval tool IS CodeGraph (the only tool that uses the
// .codegraph/ index convention). Keeps the "codegraph" string out of doctor.mjs.
export function isCodegraphTool (tool) { return ((tool || '').trim().split(/\s+/)[0].split('/').pop()) === 'codegraph' }

// The retrieval block to write into cadence.config.json — only when indexed.
export function retrievalConfig () { return { tool: RETRIEVAL_TOOL, fallback: RETRIEVAL_FALLBACK } }

// Human, copy-pasteable offer given detection state; null when already indexed (nothing to offer).
// Pure function of { indexed, cli } so it is trivially testable. [commands verified against `codegraph --help` v1.x]
export function offerText ({ indexed, cli }) {
  if (indexed) return null
  if (!cli) {
    return [
      "ℹ CodeGraph isn't installed — it makes Cadence's retrieval-first reads much cheaper (Protocol 07):",
      `    npm install -g ${PKG}     # the CLI`,
      '    codegraph init                            # index this repo (creates .codegraph/)',
      '    codegraph install                         # wire the MCP server into your agent (Claude Code, Cursor, …)',
      '  Cadence works without it (it falls back to rg/grep). Re-run adopt afterwards to wire it in.'
    ].join('\n')
  }
  return [
    "ℹ CodeGraph is installed but this repo isn't indexed. Enable retrieval-first (Protocol 07):",
    '    codegraph init            # build the .codegraph/ index',
    '  Then add to .cadence/cadence.config.json (adopt writes this automatically on a fresh config):',
    `    "retrieval": { "tool": "${RETRIEVAL_TOOL}", "fallback": "${RETRIEVAL_FALLBACK}" }`,
    '  (optional) codegraph install — wire the MCP server into your agent.'
  ].join('\n')
}

export function offer (root = process.cwd()) { return offerText(detect(root)) }
