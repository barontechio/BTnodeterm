import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * Remaining boundary pins for geometry discovery (issue #1288). Command behavior is exercised
 * through the shared planner in `shared/geometry-command.test.ts`; what
 * cannot be tested there is that Canvas.tsx — a component with no unit seam — and desktop main's
 * control handler actually REACH them. Each pin below is one wire whose loss leaves every unit test
 * green: a flag the parser accepts and the dispatch never passes on is the exact bug this issue was
 * filed for (`arrange` took `opts.gap` for years; the verb never handed it the flag).
 */
const src = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const mainSrc = readFileSync(new URL('../../main/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

/** Comments say what a block must NOT do, so a pin has to judge the code. */
const code = (body: string): string =>
  body
    .split('\n')
    .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
    .join('\n')

function between(text: string, start: string, end: string): string {
  const at = text.indexOf(start)
  expect(at, start).toBeGreaterThan(-1)
  const stop = text.indexOf(end, at + start.length)
  expect(stop, end).toBeGreaterThan(at)
  return code(text.slice(at, stop))
}

const dispatch = between(src, 'return api.onAgentControl(async ({ requestId, sourceNodeId, verb, args }) => {', "case 'open-terminal': {")
describe('the shape gate runs before anything reads a geometry flag', () => {
  it('in the renderer: once, before the routing — so both `list` answers see a well-formed call', () => {
    const belt = dispatch.indexOf('geometryArgsRefusal(verb, args)')
    expect(belt).toBeGreaterThan(-1)
    expect(dispatch.slice(belt, belt + 200)).toContain('reply({ ok: false, error: geometryRefusal })')
    expect(belt).toBeLessThan(dispatch.indexOf('routeControlSource('))
    expect(belt).toBeLessThan(dispatch.indexOf('if (!needsLiveCanvas(verb)) {'))
  })

  it('in desktop main: before the forward to the renderer (that handler never runs parseControlRequest)', () => {
    const handler = code(mainSrc.slice(mainSrc.indexOf('hookServer.setControlHandler(')))
    const gate = handler.indexOf('const geometryRefusal = geometryArgsRefusal(verb, args)')
    expect(gate).toBeGreaterThan(-1)
    expect(handler.slice(gate, gate + 200)).toContain(
      'if (geometryRefusal) return { ok: false, error: geometryRefusal, message: geometryRefusal }'
    )
    expect(gate).toBeLessThan(handler.indexOf("'window unavailable'"))
  })
})

describe('list carries geometry on both paths', () => {
  it('the live canvas reports the MEASURED geometry; the text form follows --geometry', () => {
    const live = between(src, "          case 'list': {", "          case 'open-terminal': {")
    expect(live).toContain('geometry: liveNodeGeometry(n, nodesRef.current)')
    expect(live).toContain('controlListingText(list, { geometry: listGeometryRequested(args) })')
  })

  it('the off-screen answer reads the stored nodes (persisted geometry) with the same flag', () => {
    const stored = between(src, '          if (!needsLiveCanvas(verb)) {', '// ── COLD OPEN')
    expect(stored).toContain('controlListingText(rows, { geometry: listGeometryRequested(args) })')
  })
})
