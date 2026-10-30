import { describe, expect, it, vi } from 'vitest'
import { performClaudeBranch } from './claude-branch'
import { NodeExecutionCoordinator } from './node-execution'

const originalId = '787091b8-d9ad-42ef-8313-418160ec6395'
const newId = '6766b6e5-4f86-491c-8782-5a12066fcaff'
const otherId = '4dc30742-ed1e-4caa-ac6d-26734d9fe974'
const output = (next = newId, previous = originalId) =>
  `Branched conversation. You are now in the new branch (session ${next}). Use /resume ${previous} to return to the original.`

function fixture() {
  const abort = new AbortController(); let now = 0
  const state = { sessionId: originalId, agentId: 'claude', verified: true }
  const submit = vi.fn(async () => ({ sent: true as const }))
  const capture = vi.fn(async () => {
    if (capture.mock.calls.length === 1) return 'old screen'
    state.sessionId = newId; return output()
  })
  const onDispatched = vi.fn()
  const deps = { assertCurrent: vi.fn(), session: () => ({ ...state }), capture, submit, onDispatched,
    signal: abort.signal, now: () => now, sleep: vi.fn(async (ms: number) => { now += ms }) }
  return { deps, state, abort, advance: (ms: number) => { now += ms } }
}

describe('host Claude branch proof', () => {
  it('requires a fresh branch marker AND its verified current runtime before opening can proceed', async () => {
    const f = fixture()
    expect(await performClaudeBranch(originalId, f.deps)).toEqual({ outcome: 'branched', originalId, sessionId: newId })
    expect(f.deps.submit).toHaveBeenCalledTimes(1); expect(f.deps.onDispatched).toHaveBeenCalledTimes(1)
  })

  it('waits when the hook and pane output arrive in either order', async () => {
    for (const hookFirst of [true, false]) {
      const f = fixture()
      f.deps.capture.mockImplementation(async () => {
        const pass = f.deps.capture.mock.calls.length
        if (pass === 1) return 'old'
        if (hookFirst || pass > 2) f.state.sessionId = newId
        return hookFirst && pass === 2 ? 'waiting for output' : output()
      })
      expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'branched', sessionId: newId })
      expect(f.deps.submit).toHaveBeenCalledTimes(1)
    }
  })

  it('does not reuse an old /branch result or a bare /resume instruction', async () => {
    for (const screen of [output(), `Use /resume ${originalId}`, `claude -r ${originalId}`]) {
      const f = fixture(); f.deps.capture.mockResolvedValue(screen)
      expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'uncertain', originalId })
      expect(f.deps.submit).toHaveBeenCalledTimes(1)
    }
  })

  it('requires the original session id and an unambiguous new branch', async () => {
    for (const screen of [output(newId, otherId), output() + '\n' + output(otherId)]) {
      const f = fixture(); f.deps.capture.mockResolvedValueOnce('old').mockResolvedValue(screen)
      f.deps.sleep.mockImplementation(async () => { f.advance(250); f.state.sessionId = newId })
      expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'uncertain' })
    }
  })

  it('does not infer a new session from output alone or an unrelated runtime', async () => {
    for (const current of [originalId, otherId]) {
      const f = fixture(); f.deps.capture.mockResolvedValueOnce('old').mockResolvedValue(output())
      f.state.sessionId = originalId
      f.deps.sleep.mockImplementation(async () => { f.advance(250); f.state.sessionId = current })
      expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'uncertain' })
    }
  })

  it('accepts fixed UUID grammar wrapped inside a terminal line', async () => {
    const f = fixture()
    f.deps.capture.mockResolvedValueOnce('old').mockImplementation(async () => {
      f.state.sessionId = newId
      return output().replace(newId, newId.slice(0, 8) + '\n' + newId.slice(8)).replace(originalId, originalId.slice(0, 17) + '\n' + originalId.slice(17))
    })
    expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'branched' })
  })

  it('refuses stale/unverified initial identity and oversized inspection before submission', async () => {
    for (const patch of [{ sessionId: otherId }, { verified: false }, { agentId: 'codex' }]) {
      const f = fixture(); Object.assign(f.state, patch)
      expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'refused' })
      expect(f.deps.submit).not.toHaveBeenCalled()
    }
    const f = fixture(); f.deps.capture.mockResolvedValue('x'.repeat(256 * 1024 + 1))
    expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'refused' })
    expect(f.deps.submit).not.toHaveBeenCalled()
  })

  it('preserves pre-send composer refusals without marking work', async () => {
    const f = fixture()
    const deps = { ...f.deps, submit: vi.fn(async () => ({ sent: false as const, reason: 'draft' as const })) }
    expect(await performClaudeBranch(originalId, deps)).toMatchObject({ outcome: 'refused', reason: 'branch-composer-draft' })
    expect(deps.onDispatched).not.toHaveBeenCalled()
  })

  it('refuses an unreadable baseline or a session change during inspection before typing', async () => {
    for (const changed of [true, false]) {
      const f = fixture(); f.deps.capture.mockImplementation(async () => {
        if (changed) f.state.sessionId = otherId
        return changed ? 'old screen' : ''
      })
      expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'refused' })
      expect(f.deps.submit).not.toHaveBeenCalled(); expect(f.deps.onDispatched).not.toHaveBeenCalled()
    }
  })

  it('retains uncertain delivery and never retries a failed or withheld submit', async () => {
    for (const reason of ['failed', 'not-submitted'] as const) {
      const f = fixture(); const submit = vi.fn(async () => ({ sent: false as const, reason }))
      expect(await performClaudeBranch(originalId, { ...f.deps, submit })).toMatchObject({ outcome: 'uncertain' })
      expect(submit).toHaveBeenCalledTimes(1); expect(f.deps.onDispatched).toHaveBeenCalledTimes(1)
    }
    const f = fixture(); f.deps.submit.mockRejectedValue(new Error('reply lost'))
    expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'uncertain' })
    expect(f.deps.onDispatched).toHaveBeenCalledTimes(1)
  })

  it('rejects a result that arrives after the proof deadline and keeps its dispatched hold', async () => {
    const f = fixture(); f.deps.capture.mockResolvedValueOnce('old').mockImplementation(async () => {
      f.advance(9_000); f.state.sessionId = newId; return output()
    })
    expect(await performClaudeBranch(originalId, f.deps)).toMatchObject({ outcome: 'uncertain' })
    expect(f.deps.onDispatched).toHaveBeenCalledTimes(1)
  })

  it('does not release a cancelled node claim while a dispatched inspection is still running', async () => {
    const f = fixture(); const guard = new NodeExecutionCoordinator(); let release!: (value: string) => void
    f.deps.capture.mockResolvedValueOnce('old').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    let result!: Awaited<ReturnType<typeof performClaudeBranch>>
    const running = guard.run('node', 'branch', { current: () => true }, async (permit) => {
      result = await performClaudeBranch(originalId, { ...f.deps, signal: permit.signal, assertCurrent: permit.assertCurrent })
    })
    await vi.waitFor(() => expect(release).toBeTypeOf('function'))
    guard.dispose(); expect(guard.isBusy('node')).toBe(true)
    release(output()); await expect(running).rejects.toThrow('expired')
    expect(result).toMatchObject({ outcome: 'uncertain' }); expect(guard.isBusy('node')).toBe(false)
  })
})
