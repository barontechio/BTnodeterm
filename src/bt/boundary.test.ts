import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * The fork stays mergeable only if (1) upstream files reach fork code through the seams listed
 * here and in FORK.md, and (2) fork code respects upstream's process boundaries. Adding a seam is
 * a decision: list it here AND in FORK.md.
 */
const SRC = path.resolve(__dirname, '..')
const BT = __dirname
const SEAMS = ['server/main.ts', 'main/index.ts']

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(p)
    return /\.(ts|tsx)$/.test(e.name) ? [p] : []
  })
}
const rel = (f: string): string => path.relative(SRC, f).split(path.sep).join('/')
const read = (f: string): string => fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n')
const IMPORTS = /(?:from\s+|require\(|import\()\s*['"]([^'"]+)['"]/g
const importsOf = (f: string): string[] => [...read(f).matchAll(IMPORTS)].map((m) => m[1])

describe('BT fork boundary', () => {
  it('upstream code imports src/bt only from the listed seams', () => {
    const offenders = walk(SRC)
      .filter((f) => !f.startsWith(BT + path.sep))
      .filter((f) => importsOf(f).some((s) => /(^|\/)bt\//.test(s) && s.startsWith('.')))
      .map(rel)
      .filter((f) => !SEAMS.includes(f))
    expect(offenders).toEqual([])
  })

  it('src/bt/{shared,core,server} never import electron or src/main', () => {
    const offenders = ['shared', 'core', 'server']
      .flatMap((d) => walk(path.join(BT, d)))
      .filter((f) => importsOf(f).some((s) => /^electron(\/|$)/.test(s) || /(^|\/)main\//.test(s)))
      .map(rel)
    expect(offenders).toEqual([])
  })

  it('src/bt/shared stays pure (only type imports of core, no node builtins)', () => {
    const offenders = walk(path.join(BT, 'shared')).filter((f) =>
      read(f)
        .split('\n')
        .some((l) => /^\s*import\s+(?!type\b)/.test(l) && /['"](\.\.\/)+(core|server|main|renderer)\/|['"](fs|path|os|child_process)['"]/.test(l))
    )
    expect(offenders.map(rel)).toEqual([])
  })
})
