// The completion alert must go QUIET while the parent still holds working subagent cards, and the
// unread record must stay on the other side of that gate (issue #708).
//
// This listener lives inside Canvas's useEffect. The source pins its event wiring and quiet-gate
// ordering; executing the extracted alert closure proves the effects use the captured API and
// retain unread/ack behavior. The shared decision is tested in lib/completionAlert.test.ts.
// Store reduction now lives in state/applyAgentEvent.ts and returns the quiet verdict.

import { describe, it, expect, vi } from 'vitest'
import { transformSync } from 'esbuild'
import fs from 'fs'
import path from 'path'

const src = fs.readFileSync(path.resolve(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
const reducerSrc = fs
  .readFileSync(path.resolve(__dirname, '../state/applyAgentEvent.ts'), 'utf8')
  .replace(/\r\n/g, '\n')

/** The body of the `alert` closure in the agent-status listener. */
function alertBody(): string {
  const start = src.indexOf('const alert = (')
  expect(start, 'Canvas must still build its alert closure').toBeGreaterThan(-1)
  const end = src.indexOf('const r = applyAgentEvent(', start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe('Canvas completion alert — background fan-out (issue #708)', () => {
  it('asks the shared predicate rather than re-deriving "still working" inline', () => {
    expect(reducerSrc).toContain("import { fanoutStillWorking } from '@renderer/lib/completionAlert'")
    // The verdict must be computed from the LIVE store, not from the `an` snapshot taken at
    // listener entry, and it must be handed to the alert as `quiet`.
    expect(reducerSrc).toMatch(/fanoutStillWorking\(\s*Object\.values\(nodes\.getState\(\)\.byId\),\s*e\.nodeId\s*\)/)
    expect(reducerSrc).toMatch(/alert = \{ kind: 'finished', quiet: fanoutBusy \}/)
  })

  it('gates only the completion alert, never "needs input"', () => {
    // A blocked/waiting agent needs the user NOW, whatever its subagents are doing.
    const done = src.match(/alert\('finished',[^\n]*\)/)
    expect(done, "the 'finished' alert call must still exist").toBeTruthy()
    expect(done![0]).toContain('quiet:')
    for (const m of src.matchAll(/alert\('needs input',[^\n]*\)/g)) {
      expect(m[0]).not.toContain('quiet')
    }
  })

  it('silences the chime and the OS notification but NOT the unread record', () => {
    const body = alertBody()
    const unread = body.indexOf('cs.markUnread(e.nodeId)')
    const ack = body.indexOf('ackDone(e.nodeId)')
    const quiet = body.indexOf('opts?.quiet')
    const sound = body.indexOf('playSfx(')
    const notify = body.indexOf('api.notify(')
    expect(unread).toBeGreaterThan(-1)
    expect(ack).toBeGreaterThan(-1)
    expect(quiet).toBeGreaterThan(-1)
    expect(sound).toBeGreaterThan(-1)
    expect(notify).toBeGreaterThan(-1)
    // Unread + its ack are ABOVE the quiet return; both interrupts are below it.
    expect(unread).toBeLessThan(quiet)
    expect(ack).toBeLessThan(quiet)
    expect(quiet).toBeLessThan(sound)
    expect(quiet).toBeLessThan(notify)
    // And the gate is a hard return, so nothing after it can leak through.
    expect(body).toMatch(/if \(opts\?\.quiet\) return/)
  })

  it.each([
    { quiet: true, focused: false, expected: ['unread'] },
    { quiet: true, focused: true, expected: ['ack'] },
    { quiet: false, focused: false, expected: ['unread', 'sound', 'notify'] }
  ])('executes the actual alert with quiet=$quiet and focused=$focused', ({ quiet, focused, expected }) => {
    const calls: string[] = []
    const globalNotify = vi.fn()
    const capturedNotify = vi.fn(() => calls.push('notify'))
    const deps = {
      document: { hasFocus: () => focused },
      cs: { activeId: focused ? 'node' : null, markUnread: () => calls.push('unread') },
      e: { nodeId: 'node', lastMessage: 'Finished' },
      window: { nodeTerminal: { ackDone: () => calls.push('ack'), notify: globalNotify } },
      api: { notify: capturedNotify },
      suppressDoneAfterHandoff: () => false,
      useSettings: { getState: () => ({ settings: {
        soundEffects: true, soundVolume: 1, notifyOnClaudeDone: true, notifyConsentAsked: true
      } }) },
      sfxCooldownRef: { current: {} }, notifyCooldownRef: { current: {} },
      playSfx: () => calls.push('sound'), contextFor: () => 'Project', agentLabel: 'Claude',
      clip: (value: string) => value
    }
    // Run the shipped closure, including its early return and captured API, without mounting PTYs.
    const code = transformSync(alertBody() + '\nreturn alert;', { loader: 'ts', target: 'es2022' }).code
    const alert = new Function(...Object.keys(deps), code)(...Object.values(deps))
    alert('finished', 'Fallback', 'done', { quiet })
    expect(calls).toEqual(expected)
    expect(globalNotify).not.toHaveBeenCalled()
    expect(capturedNotify).toHaveBeenCalledTimes(quiet ? 0 : 1)
  })
})
