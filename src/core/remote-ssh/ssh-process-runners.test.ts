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
afterEach(async () => { for (const done of pending) done(); await Promise.resolve(); pending.length = 0; vi.unstubAllEnvs() })

function factory() {
  return makeSshProjectRunners({ userDataDir: '/fixture',
    agent: { env: () => ({}), start: async () => {}, scheduleStop: () => {} },
    askpass: { envFor: () => ({}), wasCancelledBy: () => false, isPromptingAny: () => false, askedBy: () => false },
    getHook: () => ({ port: 0, token: '', version: '' }), onStatus: () => {} })
}
const args = ['-o', 'ControlPath=/fixture', 'fixture@host', 'printf executed']

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

  it('rechecks a request identity after waiting behind unrelated SSH commands', async () => {
    vi.stubEnv('NODETERM_NATIVE_SSH', '0')
    const runners = factory(); let current = true
    const running = Array.from({ length: SSH_CHILD_CONCURRENCY }, () => runners.run(args))
    const stale = runners.withQueuedExecutionCheck(() => current, () => runners.run(args))
    await Promise.resolve(); await Promise.resolve()
    expect(pending).toHaveLength(SSH_CHILD_CONCURRENCY)
    current = false; pending[0]()
    expect(await stale).toEqual({ code: 255, stdout: '' })
    expect(pending).toHaveLength(SSH_CHILD_CONCURRENCY)
    for (const done of pending.slice(1)) done()
    await Promise.all(running)
  })

  it('refuses detached continuations and inactive parent scopes before starting a child', async () => {
    vi.stubEnv('NODETERM_NATIVE_SSH', '0')
    const runners = factory()
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let late!: Promise<{ code: number; stdout: string }>
    await runners.withQueuedExecutionCheck(() => true, () => {
      late = runners.withQueuedExecutionCheck(() => true, async () => { await held; return runners.run(args) })
    })
    release(); expect(await late).toEqual({ code: 255, stdout: '' })
    expect(pending).toHaveLength(0)
    const work = vi.fn()
    await expect(runners.withQueuedExecutionCheck(() => false, work)).rejects.toThrow('ssh-request-stale')
    expect(work).not.toHaveBeenCalled()
  })

  it('contains failed request checks and still allows an unrelated command', async () => {
    vi.stubEnv('NODETERM_NATIVE_SSH', '0')
    const runners = factory(); let current = true
    const blocked = runners.withQueuedExecutionCheck(() => {
      if (!current) throw new Error('source replaced')
      return true
    }, async () => { current = false; return runners.run(args) })
    expect(await blocked).toEqual({ code: 255, stdout: '' })
    const ordinary = runners.run(args)
    await Promise.resolve(); await Promise.resolve()
    expect(pending).toHaveLength(1); pending[0]()
    expect(await ordinary).toEqual({ code: 0, stdout: 'executed' })
  })
})
