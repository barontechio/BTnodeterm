import { describe, it, expect, vi } from 'vitest'
import { startBtExtensions } from './extensions'
import { infoExtension } from './info'
import type { CorePlatform } from '../../core/platform'
import type { BtExtension } from '../shared/extension'

function fakePlatform(): CorePlatform & { handlers: Map<string, (...a: unknown[]) => unknown> } {
  const handlers = new Map<string, (...a: unknown[]) => unknown>()
  return {
    handlers,
    userDataDir: '/data',
    appVersion: '0.4.5',
    isPackaged: false,
    handle: (c, fn) => void handlers.set(c, fn),
    on: () => {},
    handleWithSender: () => {},
    onWithSender: () => {},
    sendTo: () => {},
    broadcast: () => {},
    clientIds: () => [],
    openExternal: async () => {}
  }
}

const quiet = (): void => {}

describe('startBtExtensions', () => {
  it('skips a failing extension and keeps starting the rest', async () => {
    const ok: BtExtension = { id: 'ok', start: () => {} }
    const bad: BtExtension = { id: 'bad', start: () => { throw new Error('boom') } }
    const rt = await startBtExtensions('server', fakePlatform(), [bad, ok], quiet)
    expect(rt.started).toEqual(['ok'])
  })

  it('honours editions, refuses bad and duplicate ids', async () => {
    const exts: BtExtension[] = [
      { id: 'desk', editions: ['desktop'], start: () => {} },
      { id: 'Bad Id', start: () => {} },
      { id: 'a', start: () => {} },
      { id: 'a', start: () => {} }
    ]
    const rt = await startBtExtensions('server', fakePlatform(), exts, quiet)
    expect(rt.started).toEqual(['a'])
  })

  it('stops in reverse order, once, despite a throwing stop', async () => {
    const order: string[] = []
    const mk = (id: string, fail = false): BtExtension => ({
      id,
      start: () => ({ stop: () => { order.push(id); if (fail) throw new Error('x') } })
    })
    const rt = await startBtExtensions('desktop', fakePlatform(), [mk('a'), mk('b', true), mk('c')], quiet)
    await rt.stop()
    await rt.stop()
    expect(order).toEqual(['c', 'b', 'a'])
  })

  it('passes a per-extension data dir under <userData>/bt', async () => {
    const start = vi.fn()
    await startBtExtensions('server', fakePlatform(), [{ id: 'x', start }], quiet)
    expect(start.mock.calls[0][0].dataDir).toMatch(/[\\/]data[\\/]bt[\\/]x$/)
  })

  it('info extension answers on both shells', async () => {
    const p = fakePlatform()
    await startBtExtensions('server', p, [infoExtension], quiet)
    expect(p.handlers.get('bt:info:get')!()).toMatchObject({ fork: 'BTnodeterm', edition: 'server' })
  })
})
