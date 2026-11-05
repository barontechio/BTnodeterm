import { describe, expect, it, vi } from 'vitest'
import { retireFramesIfAvailable } from './groupRetirement'

const metadata = (state: 'reserved' | 'released' | 'consumed') => ({ version: 1, reservations: [
  { id: 'pending', state, position: { x: 28, y: 62 }, width: 640, height: 440,
    ...(state === 'consumed' ? { nodeId: 'opened' } : {}) }
] })

describe('frame retirement before worktree/session effects', () => {
  it('refuses an entire live or stored selection before any binding/PTY/history mutation', () => {
    for (const frame of [
      { id: 'g', type: 'group', data: { dynamicGroup: metadata('reserved') } },
      { id: 'g', kind: 'group', dynamicGroup: metadata('reserved') }
    ]) {
      const retire = vi.fn(), blocked = vi.fn()
      expect(retireFramesIfAvailable([frame, { id: 'terminal', type: 'terminal' }], ['terminal', 'g'], retire, blocked)).toBe(false)
      expect(retire).not.toHaveBeenCalled(); expect(blocked).toHaveBeenCalledOnce()
    }
  })
  it('permits settled tombstones and unrelated selections without changing their metadata', () => {
    for (const state of ['released', 'consumed'] as const) {
      const frame = { id: 'g', kind: 'group', dynamicGroup: metadata(state) }, before = structuredClone(frame)
      const retire = vi.fn()
      expect(retireFramesIfAvailable([frame], ['g'], retire)).toBe(true)
      expect(retire).toHaveBeenCalledOnce(); expect(frame).toEqual(before)
    }
    const retire = vi.fn()
    expect(retireFramesIfAvailable([{ id: 'g', kind: 'group', dynamicGroup: metadata('reserved') }], ['another'], retire)).toBe(true)
    expect(retire).toHaveBeenCalledOnce()
  })
})
