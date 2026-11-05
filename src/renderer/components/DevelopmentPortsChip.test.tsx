// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DevelopmentPortsChip } from './DevelopmentPortsChip'
import type { DevelopmentPreviewApi } from '@shared/development-preview'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root, host: HTMLDivElement
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
const button = (label: string) => [...document.querySelectorAll('button')].find(b => b.textContent === label)!
function api(): DevelopmentPreviewApi {
  return { status: vi.fn(async () => ({ supported: true, storage: 'disabled' as const })), list: vi.fn(async () => [{ id: 'record', label: 'Port 3000' }]),
    open: vi.fn(async () => 'https://grant.preview.example.net'), stop: vi.fn(async () => {}) }
}
it('selects only an opaque host record, exposes storage limits and supports human stop', async () => {
  const bridge = api()
  await act(async () => root.render(<DevelopmentPortsChip api={bridge} projectId="p" nodeId="n" />))
  expect(bridge.list).not.toHaveBeenCalled()
  await act(async () => button('Preview').click())
  expect(bridge.list).toHaveBeenCalledExactlyOnceWith({ projectId: 'p', nodeId: 'n' })
  expect(document.body.textContent).toContain('browser storage')
  await act(async () => { button('Allow preview').click(); button('Allow preview').click() })
  expect(bridge.open).toHaveBeenCalledExactlyOnceWith('record')
  const link = document.querySelector('a')!
  expect(link.href).toBe('https://grant.preview.example.net/')
  expect(link.rel).toBe('noopener noreferrer')
  await act(async () => button('Stop').click())
  expect(bridge.stop).toHaveBeenCalledExactlyOnceWith('https://grant.preview.example.net')
  expect(document.querySelector('a')).toBeNull()
})
it('stops a late grant when its scope has been unmounted and does not replay an unknown reply', async () => {
  const bridge = api()
  let finish!: (url: string) => void
  bridge.open = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
  await act(async () => root.render(<DevelopmentPortsChip api={bridge} projectId="p" nodeId="n" />))
  await act(async () => button('Preview').click())
  act(() => button('Allow preview').click())
  await act(async () => root.render(<div />))
  await act(async () => finish('https://late.preview.example.net'))
  expect(bridge.open).toHaveBeenCalledOnce()
  expect(bridge.stop).toHaveBeenCalledExactlyOnceWith('https://late.preview.example.net')
})
it('an unsupported host causes no discovery and has no localhost fallback', async () => {
  const bridge = api(); bridge.status = vi.fn(async () => ({ supported: false, storage: 'disabled' as const }))
  await act(async () => root.render(<DevelopmentPortsChip api={bridge} projectId="p" nodeId="n" />))
  expect(document.querySelector('button')).toBeNull(); expect(bridge.list).not.toHaveBeenCalled()
})
