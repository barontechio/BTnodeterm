// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorktreeRecoveryHost } from './WorktreeRecoveryHost'
import type { WorktreeRecoveryApi, WorktreeRecoveryInspection, WorktreeRecoveryItem, WorktreeRecoveryKeepReply } from '../../shared/worktree-recovery'
import { hasOwnerConfirmation } from '../lib/ownerConfirmationSlot'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const row: WorktreeRecoveryItem = { id: 'record', createdAt: 1, phase: 'prepared', projectId: 'p', groupId: 'group',
  repoPath: '/repo', path: '/checkout', branch: 'feature', fallbackCwd: '/repo', memberIds: ['group', 'member'] }
const button = (text: string) => [...document.querySelectorAll('button')].find((item) => item.textContent === text)!
function deferred<T>() { let resolve!: (value: T) => void; return { promise: new Promise<T>((done) => { resolve = done }), resolve: (value: T) => resolve(value) } }
describe('owner worktree recovery UI', () => {
  let root: Root; let host: HTMLDivElement
  beforeEach(() => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    window.nodeTerminal = {} as typeof window.nodeTerminal
  })
  afterEach(() => { act(() => root.unmount()); host.remove() })
  const fixture = (): WorktreeRecoveryApi => ({ list: vi.fn(async () => ({ ok: true as const, records: [row] })),
    inspect: vi.fn(async () => ({ ok: true as const, record: row, status: 'kept' as const })),
    keep: vi.fn(async () => ({ ok: true as const, outcome: 'kept' as const, message: 'Checkout kept.' })) })

  it('requires a reviewed owner click, prevents double dispatch and retains the result before another action', async () => {
    const api = fixture(); const done = deferred<WorktreeRecoveryKeepReply>()
    api.keep = vi.fn(() => done.promise)
    await act(async () => root.render(<WorktreeRecoveryHost api={api} />))
    await act(async () => button('Worktree recovery (1)').click())
    expect(hasOwnerConfirmation()).toBe(true)
    expect(document.body.textContent).toContain('/checkout')
    expect(document.activeElement?.tagName).not.toBe('BUTTON')
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(api.keep).not.toHaveBeenCalled()
    act(() => { button('Keep existing checkout').click(); button('Keep existing checkout').click() })
    expect(api.keep).toHaveBeenCalledExactlyOnceWith('record')
    await act(async () => done.resolve({ ok: true, outcome: 'kept', message: 'Checkout kept.' }))
    expect(document.body.textContent).toContain('Checkout kept.')
    expect(button('Keep existing checkout')).toBeUndefined()
    act(() => button('Close').click()); expect(hasOwnerConfirmation()).toBe(false)
  })

  it('does not replay an uncertain action during focus refresh', async () => {
    const api = fixture(); api.keep = vi.fn(async () => { throw new Error('reply lost') })
    await act(async () => root.render(<WorktreeRecoveryHost api={api} />))
    await act(async () => button('Worktree recovery (1)').click())
    await act(async () => button('Keep existing checkout').click())
    expect(document.body.textContent).toContain('Recovery may have completed.')
    await act(async () => window.dispatchEvent(new Event('focus')))
    expect(api.keep).toHaveBeenCalledOnce(); expect(button('Keep existing checkout')).toBeUndefined()
  })

  it('ignores an old inspection after the host API changes and releases its dialog reservation', async () => {
    const api = fixture(); const inspection = deferred<WorktreeRecoveryInspection>(); api.inspect = () => inspection.promise
    await act(async () => root.render(<WorktreeRecoveryHost api={api} />))
    await act(async () => button('Worktree recovery (1)').click())
    expect(button('Keep existing checkout')).toBeUndefined()
    const other = fixture(); other.list = async () => ({ ok: true, records: [] })
    await act(async () => root.render(<WorktreeRecoveryHost api={other} />))
    await act(async () => inspection.resolve({ ok: true, record: row, status: 'kept' }))
    expect(host.textContent).toBe(''); expect(hasOwnerConfirmation()).toBe(false)
    expect(api.keep).not.toHaveBeenCalled(); expect(other.keep).not.toHaveBeenCalled()
  })

  it('stays hidden for older hosts and recovered tombstones', async () => {
    const api = fixture(); api.list = async () => null
    await act(async () => root.render(<WorktreeRecoveryHost api={api} />))
    expect(host.textContent).toBe('')
    const recovered = fixture(); recovered.list = async () => ({ ok: true, records: [{ ...row, phase: 'recovered' }] })
    await act(async () => root.render(<WorktreeRecoveryHost api={recovered} />))
    expect(host.textContent).toBe('')
  })
})
