// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('@xyflow/react', () => ({ Handle: () => null, NodeResizer: () => null, Position: { Top: 'top' }, useReactFlow: () => ({ deleteElements: vi.fn() }), useStoreApi: () => ({ getState: () => ({}) }) }))
vi.mock('../components/Tooltip', () => ({ Tooltip: ({ children }: { children: unknown }) => children }))
import BrowserWebNode from './BrowserWebNode'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('embeds external pages with an opaque sandbox and always offers the external fallback', async () => {
  const host = document.createElement('div'); const root = createRoot(host)
  window.nodeTerminal = { shell: { openExternal: vi.fn() } } as unknown as typeof window.nodeTerminal
  const render = (url: string) => act(() => root.render(<BrowserWebNode {...({ id: 'web', data: { title: 'Page', url }, selected: false } as Parameters<typeof BrowserWebNode>[0])} />))
  render('https://example.com')
  expect(host.querySelector('iframe')?.getAttribute('src')).toBe('https://example.com/')
  expect(host.querySelector('iframe')?.getAttribute('sandbox')).not.toContain('allow-same-origin')
  const open = host.querySelector('[aria-label="Open in new tab"]') as HTMLButtonElement
  expect(open).not.toBeNull(); act(() => open.click())
  expect(window.nodeTerminal.shell.openExternal).toHaveBeenCalledWith('https://example.com/')
  render('http://localhost:3000')
  expect(host.querySelector('iframe')).toBeNull()
  expect(host.textContent).toContain('preview gateway')
  act(() => root.unmount())
})

it('releases a late HTML grant after the node unmounts', async () => {
  const host = document.createElement('div'); const root = createRoot(host)
  let finish!: (url: string) => void
  const release = vi.fn(async () => {})
  window.nodeTerminal = { webPreview: { allow: () => new Promise<string>((resolve) => { finish = resolve }), release, renew: vi.fn(async () => true) } } as unknown as typeof window.nodeTerminal
  act(() => root.render(<BrowserWebNode {...({ id: 'web', data: { filePath: '/page.html' }, selected: false } as Parameters<typeof BrowserWebNode>[0])} />))
  act(() => root.unmount())
  await act(async () => finish('https://preview.example.test/web-preview?ref=one'))
  expect(release).toHaveBeenCalledExactlyOnceWith('https://preview.example.test/web-preview?ref=one')
})

it('keeps scripts disabled in an issued local HTML iframe and releases it on unmount', async () => {
  const host = document.createElement('div'); const root = createRoot(host)
  const release = vi.fn(async () => {})
  window.nodeTerminal = { webPreview: { allow: async () => 'https://preview.example.test/web-preview?ref=local', release, renew: vi.fn(async () => true) } } as unknown as typeof window.nodeTerminal
  await act(async () => root.render(<BrowserWebNode {...({ id: 'web', data: { filePath: '/page.html' }, selected: false } as Parameters<typeof BrowserWebNode>[0])} />))
  expect(host.querySelector('iframe')?.getAttribute('sandbox')).toBe('')
  expect(host.textContent).toContain('static HTML')
  act(() => root.unmount())
  expect(release).toHaveBeenCalledTimes(1)
})
