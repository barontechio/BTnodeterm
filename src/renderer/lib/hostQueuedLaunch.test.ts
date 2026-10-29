import { describe, expect, it, vi } from 'vitest'
import { runHostQueuedLaunch } from './hostQueuedLaunch'
import { buildStubApi } from '../bridge/stubs'

describe('host-owned Run now', () => {
  it('keeps legacy launches on their existing writer and never falls back after uncertainty', async () => {
    const api = buildStubApi()
    expect(await runHostQueuedLaunch(api, 'node', { after: [], command: 'task' })).toBeNull()
    const run = vi.fn(async () => { throw new Error('socket closed') })
    api.control = { capabilities: async () => null, runLaunch: run }
    expect(await runHostQueuedLaunch(api, 'node', { after: [], command: 'task', executor: 'server' })).toMatchObject({ ok: false, started: false })
    expect(run).toHaveBeenCalledTimes(1)
  })
})
