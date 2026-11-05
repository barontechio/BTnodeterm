import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import * as atomic from './fs-atomic'
import { SettingsStore } from './settings-store'
import { IPC } from '../shared/ipc'
import type { Settings } from '../shared/types'

describe('serialized owner settings patches', () => {
  let platform: FakePlatform
  let store: SettingsStore
  beforeEach(() => {
    platform = fakePlatform({ isOwnerClient: (id) => id === 1 || id === 2 })
    platform.clients.push(1, 2, 3)
    resetPlatformForTests(); initPlatform(platform)
    store = new SettingsStore(); store.init(); store.registerIpc()
  })
  afterEach(() => { vi.restoreAllMocks(); resetPlatformForTests() })

  it('merges concurrent owner edits and host updates without publishing an uncommitted cache', async () => {
    const before = store.get().fontSize
    let resume!: () => void; const gate = new Promise<void>((resolve) => { resume = resolve })
    let started!: () => void; const entered = new Promise<void>((resolve) => { started = resolve })
    const write = atomic.writeFileAtomic
    vi.spyOn(atomic, 'writeFileAtomic').mockImplementationOnce(async (...args) => { started(); await gate; await write(...args) })
    const first = platform.handlers[IPC.settingsPatch](1, { fontSize: 21 }) as Promise<Settings>
    await entered
    expect(store.get().fontSize).toBe(before)
    const second = platform.handlers[IPC.settingsPatch](2, { gridSize: 24 }) as Promise<Settings>
    const third = store.update((current) => ({ ...current, fontSize: current.fontSize + 1 }))
    resume(); await Promise.all([first, second, third])
    expect(store.get()).toMatchObject({ fontSize: 22, gridSize: 24 })
    const disk = JSON.parse(await fs.readFile(path.join(platform.userDataDir, 'settings.json'), 'utf8'))
    expect(disk).toMatchObject({ fontSize: 22, gridSize: 24 })
    expect(platform.sent.some((message) => message.to === 3 || message.to === 'broadcast')).toBe(false)
  })

  it('retains the durable cache and sends no success event when a write fails', async () => {
    await store.patch({ fontSize: 19 })
    platform.sent.length = 0
    const listener = vi.fn(); store.onChange(listener)
    const before = structuredClone(store.get())
    vi.spyOn(atomic, 'writeFileAtomic').mockRejectedValueOnce(new Error('disk full'))
    await expect(store.patch({ fontSize: 25 })).rejects.toThrow('disk full')
    expect(store.get()).toEqual(before); expect(listener).not.toHaveBeenCalled(); expect(platform.sent).toEqual([])
    expect(JSON.parse(await fs.readFile(path.join(platform.userDataDir, 'settings.json'), 'utf8')).fontSize).toBe(19)
    await store.patch({ gridSize: 32 })
    expect(store.get()).toMatchObject({ fontSize: 19, gridSize: 32 })
  })

  it('refuses guests and invalid payloads, while an empty patch is a queued write barrier', async () => {
    expect(() => platform.handlers[IPC.settingsPatch](3, { fontSize: 25 })).toThrow('owner-required')
    expect(() => platform.handlers[IPC.settingsPatch](1, [])).toThrow('invalid-patch')
    const update = store.patch({ fontSize: 20 })
    const barrier = platform.handlers[IPC.settingsPatch](1, {}) as Promise<Settings>
    await update
    expect(await barrier).toMatchObject({ fontSize: 20 })
  })
})
