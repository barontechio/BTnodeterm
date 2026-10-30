import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeSshProjectRunners } from './ssh-process-runners'
import { SSH_CHILD_CONCURRENCY } from './ssh-child-gate'

const pending = vi.hoisted(() => [] as Array<() => void>)
vi.mock('node:child_process', () => ({
  spawn: vi.fn(), execFileSync: vi.fn(),
  execFile: vi.fn((_file, _args, _options, callback) => {
    pending.push(() => callback(null, 'executed'))
    return { stdin: { on: () => {}, end: () => {} } }
  })
}))
afterEach(() => { pending.length = 0; vi.unstubAllEnvs() })

describe('SSH execution destination at the queue boundary', () => {
  it('captures before queueing and refuses an old generation without spawning a command', async () => {
    vi.stubEnv('NODETERM_NATIVE_SSH', '0')
    let generation = 1
    const runners = makeSshProjectRunners({
      userDataDir: '/fixture',
      agent: { env: () => ({}), start: async () => {}, scheduleStop: () => {} },
      askpass: { envFor: () => ({}), wasCancelledBy: () => false, isPromptingAny: () => false, askedBy: () => false },
      getHook: () => ({ port: 0, token: '', version: '' }), onStatus: () => {},
      captureExecutionCheck: () => { const captured = generation; return () => captured === generation }
    })
    const args = ['-o', 'ControlPath=/fixture', 'fixture@host', 'printf executed']
    const running = Array.from({ length: SSH_CHILD_CONCURRENCY }, () => runners.run(args))
    const stale = runners.run(args)
    await Promise.resolve(); await Promise.resolve()
    expect(pending).toHaveLength(SSH_CHILD_CONCURRENCY)
    generation++
    pending[0]()
    expect(await stale).toEqual({ code: 255, stdout: '' })
    expect(pending).toHaveLength(SSH_CHILD_CONCURRENCY)
    for (const done of pending.slice(1)) done()
    await Promise.all(running)
  })
})
