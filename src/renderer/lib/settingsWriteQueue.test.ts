import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Settings, type SettingsApi } from '../../shared/types'
import { SettingsWriteQueue } from './settingsWriteQueue'

describe('explicit settings edits and host synchronization', () => {
  let current: Settings
  let api: SettingsApi
  let queue: SettingsWriteQueue
  let failed: ReturnType<typeof vi.fn<() => void>>
  const edit = (patch: Partial<Settings>) => { current = { ...current, ...patch }; queue.schedule(current, patch) }
  beforeEach(() => {
    vi.useFakeTimers(); current = structuredClone(DEFAULT_SETTINGS); failed = vi.fn()
    api = { load: async () => current, save: vi.fn(async () => {}),
      patch: vi.fn(async (patch) => ({ ...current, ...patch })), onChanged: () => () => {} }
    queue = new SettingsWriteQueue({ api: () => api, current: () => current, apply: (next) => { current = next }, failed })
  })
  afterEach(() => vi.useRealTimers())

  it('merges host changes with pending user edits and sends only those explicit edits', async () => {
    api.patch = vi.fn(async (patch) => {
      const committed = { ...current, ...patch }
      queue.receive(committed)
      return committed
    })
    edit({ fontSize: 21 })
    queue.receive({ ...DEFAULT_SETTINGS, gridSize: 24 })
    expect(current).toMatchObject({ fontSize: 21, gridSize: 24 })
    await vi.advanceTimersByTimeAsync(300)
    expect(api.patch).toHaveBeenCalledExactlyOnceWith({ fontSize: 21 })
    expect(api.save).not.toHaveBeenCalled()
    expect(current).toMatchObject({ fontSize: 21, gridSize: 24 })
  })

  it('keeps newer local edits while an earlier request is unacknowledged', async () => {
    let finish!: (value: Settings) => void
    api.patch = vi.fn(() => new Promise<Settings>((resolve) => { finish = resolve }))
    edit({ fontSize: 20 }); await vi.advanceTimersByTimeAsync(300)
    edit({ fontSize: 22 })
    queue.receive({ ...DEFAULT_SETTINGS, fontSize: 20, gridSize: 24 })
    expect(current).toMatchObject({ fontSize: 22, gridSize: 24 })
    finish({ ...DEFAULT_SETTINGS, fontSize: 20, gridSize: 24 }); await vi.advanceTimersByTimeAsync(0)
    expect(current).toMatchObject({ fontSize: 22, gridSize: 24 })
  })

  it('does not resurrect a failed older edit over a newer successful edit', async () => {
    let fail!: (error: Error) => void
    api.patch = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
      .mockImplementation(async (patch) => ({ ...current, ...patch }))
    edit({ fontSize: 20 }); await vi.advanceTimersByTimeAsync(300)
    edit({ fontSize: 22 }); await vi.advanceTimersByTimeAsync(300)
    queue.receive({ ...DEFAULT_SETTINGS, fontSize: 22, gridSize: 24 })
    fail(new Error('lost old reply')); await vi.advanceTimersByTimeAsync(0)
    expect(current).toMatchObject({ fontSize: 22, gridSize: 24 })
    await queue.flushPending()
    expect(api.patch).toHaveBeenCalledTimes(2)
  })

  it('keeps uncertain patches for an explicit flush and never falls back to a full save after an error', async () => {
    api.patch = vi.fn().mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue({ ...current, fontSize: 20 })
    edit({ fontSize: 20 }); await vi.advanceTimersByTimeAsync(300)
    expect(failed).toHaveBeenCalledOnce(); expect(api.save).not.toHaveBeenCalled()
    await queue.flush()
    expect(api.patch).toHaveBeenNthCalledWith(2, { fontSize: 20 })
  })

  it('negotiates a legacy full save only for the explicit null reply and preserves host changes in its snapshot', async () => {
    api.patch = vi.fn(async () => null)
    edit({ fontSize: 20 }); queue.receive({ ...DEFAULT_SETTINGS, gridSize: 24 })
    await queue.flushPending()
    expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 20, gridSize: 24 }))
  })

  it('does not write a clean page on unload, while an explicit flush waits for prior submissions', async () => {
    await queue.flushPending(); expect(api.patch).not.toHaveBeenCalled()
    let finish!: (value: Settings) => void
    api.patch = vi.fn().mockImplementationOnce(() => new Promise<Settings>((resolve) => { finish = resolve }))
      .mockResolvedValue(current)
    edit({ fontSize: 20 }); await vi.advanceTimersByTimeAsync(300)
    let flushed = false
    const flushing = queue.flush().then(() => { flushed = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(flushed).toBe(false)
    finish({ ...current, fontSize: 20 }); await flushing
    expect(api.patch).toHaveBeenNthCalledWith(2, {})
    expect(flushed).toBe(true)
  })
})
