// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
vi.mock('@xyflow/react', () => ({ Handle: () => null, NodeResizer: () => null, Position: { Top: 'top' }, useReactFlow: () => ({ deleteElements: vi.fn() }), useStoreApi: () => ({ getState: () => ({}) }) }))
vi.mock('../components/Tooltip', () => ({ Tooltip: ({ children }: { children: unknown }) => children }))
import VideoNode from './VideoNode'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
it('renders audio controls, clears a stale source and ignores the old request after a file change', async () => {
  const host = document.createElement('div'); document.body.appendChild(host)
  const root = createRoot(host)
  const requests: Array<(url: string) => void> = []
  const release = vi.fn(async () => {})
  window.nodeTerminal = { media: { allow: vi.fn(() => new Promise<string>((r) => requests.push(r))), release } } as unknown as typeof window.nodeTerminal
  const render = (filePath: string) => act(() => root.render(<VideoNode {...({ id: 'media', data: { filePath }, selected: false } as Parameters<typeof VideoNode>[0])} />))
  render('/a.mp3')
  await act(async () => requests[0]('nt-media://media/a.mp3'))
  expect(host.querySelector('audio')?.getAttribute('src')).toBe('nt-media://media/a.mp3')
  expect(host.querySelector('video')).toBeNull()
  expect(host.querySelector('audio')?.closest('.nopan.nowheel.nodrag')).not.toBeNull()
  render('/b.mp4')
  expect(release).toHaveBeenCalledWith('nt-media://media/a.mp3')
  expect(host.querySelector('audio,video')).toBeNull()
  render('/c.wav')
  await act(async () => requests[1]('nt-media://media/b.mp4'))
  expect(release).toHaveBeenCalledWith('nt-media://media/b.mp4')
  expect(host.querySelector('audio,video')).toBeNull()
  await act(async () => requests[2]('nt-media://media/c.wav'))
  expect(host.querySelector('audio')?.getAttribute('src')).toBe('nt-media://media/c.wav')
  act(() => root.unmount()); host.remove()
  expect(release).toHaveBeenCalledWith('nt-media://media/c.wav')
})

it('renews a mounted HTTP reference and stops renewing when the player unmounts', async () => {
  vi.useFakeTimers()
  const host = document.createElement('div'); const root = createRoot(host)
  const renew = vi.fn(async () => true); const release = vi.fn(async () => {})
  window.nodeTerminal = { media: { allow: vi.fn(async () => '/media?ref=clip'), renew, release } } as unknown as typeof window.nodeTerminal
  try {
    await act(async () => root.render(<VideoNode {...({ id: 'media', data: { filePath: '/clip.mp4' }, selected: false } as Parameters<typeof VideoNode>[0])} />))
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(renew).toHaveBeenCalledExactlyOnceWith('/media?ref=clip')
    act(() => root.unmount())
    await vi.advanceTimersByTimeAsync(120_000)
    expect(renew).toHaveBeenCalledTimes(1)
    expect(release).toHaveBeenCalledExactlyOnceWith('/media?ref=clip')
  } finally { vi.useRealTimers() }
})
