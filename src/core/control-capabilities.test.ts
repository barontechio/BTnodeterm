import { afterEach, describe, expect, it } from 'vitest'
import { VERBS_FOR_TEST } from './canvas-control-core'
import { controlCapabilitiesReply, registerControlCapabilities } from './control-capabilities'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { IPC } from '../shared/ipc'
import { isHostOnlyChannel } from '../shared/host-control'
import {
  controlCapabilities,
  serverSupportsControl
} from '../shared/control-capabilities'

afterEach(() => resetPlatformForTests())

describe('control capability discovery', () => {
  it('describes every parsed verb and keeps implementation distinct from enabling control', () => {
    const report = controlCapabilities('server', false)
    expect(report.enabled).toBe(false)
    expect(report.verbs.map((v) => v.verb).sort()).toEqual([...VERBS_FOR_TEST].sort())
    expect(report.verbs.find((v) => v.verb === 'list')?.support).toBe('supported')
    expect(report.verbs.find((v) => v.verb === 'browser')?.support).toBe('unsupported')
    expect(report.verbs.find((v) => v.verb === 'settings')).toMatchObject({
      support: 'partial', limitation: expect.stringContaining('individual confirmation')
    })
    expect(report.verbs.find((v) => v.verb === 'write')).toMatchObject({
      support: 'partial', limitation: expect.stringContaining('empty composer')
    })
    expect(report.verbs.find((v) => v.verb === 'branch')).toMatchObject({
      support: 'partial', limitation: expect.stringContaining('individual owner approval')
    })
    expect(serverSupportsControl('list')).toBe(true)
    expect(serverSupportsControl('browser')).toBe(false)
    for (const unknown of ['constructor', '__proto__', 'toString', 'LIST', '']) {
      expect(serverSupportsControl(unknown)).toBe(false)
    }
  })

  it('reports Desktop implementations and the shared coordinated branch limitation', () => {
    const report = controlCapabilities('desktop', true)
    expect(report.verbs.filter((v) => v.verb !== 'branch').every((v) => v.support === 'supported' && v.limitation === undefined)).toBe(true)
    expect(report.verbs.find((v) => v.verb === 'branch')).toMatchObject({ support: 'partial', limitation: expect.stringContaining('POSIX tmux') })
    report.verbs.length = 0
    expect(controlCapabilities('desktop', true).verbs).toHaveLength(VERBS_FOR_TEST.length)
  })

  it('reads the live host flag, serves the same report over RPC and CLI, and rejects unverified calls', () => {
    const p = fakePlatform()
    initPlatform(p)
    let enabled = false
    const read = registerControlCapabilities('server', () => enabled)
    expect(p.handlers[IPC.controlCapabilities]()).toMatchObject({ edition: 'server', enabled: false })
    enabled = true
    const reply = controlCapabilitiesReply(read(), {}, true)
    expect(reply).toMatchObject({ ok: true, result: p.handlers[IPC.controlCapabilities]() })
    expect(reply.message).toContain('Support is not authorization')
    expect(controlCapabilitiesReply(read(), {}, false)).toMatchObject({ ok: false })
    expect(controlCapabilitiesReply(read(), { set: 'project' }, true)).toMatchObject({ ok: false })
    expect(isHostOnlyChannel(IPC.controlCapabilities)).toBe(true)
  })
})
