// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OwnerConfirmation, OwnerConfirmationApi } from '../../shared/owner-confirmation'
import { OwnerConfirmationHost } from './OwnerConfirmationHost'
import { hasOwnerConfirmation, registerConfirmationBlocker } from '../lib/ownerConfirmationSlot'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
describe('owner confirmation UI lifecycle', () => {
  let root: Root
  let host: HTMLDivElement
  let api: OwnerConfirmationApi
  let request: (message: OwnerConfirmation) => void
  let dismiss: (id: string) => void
  const message = (id = 'one'): OwnerConfirmation => ({ id, token: `token-${id}`, proof: `proof-${id}`, action: 'settings',
    requester: { nodeId: 'agent', projectId: 'p', title: 'Builder' }, message: 'Change the grid?',
    details: 'old: 16\nnew: 24', confirmLabel: 'Change', danger: false,
    expiresAt: Date.now() + 5000, remainingMs: 5000 })
  beforeEach(async () => {
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host)
    api = { connect: vi.fn(async () => 'epoch'), disconnect: vi.fn(async () => {}), decide: vi.fn(async () => true),
      onRequest: (listener) => { request = listener; return () => {} },
      onDismiss: (listener) => { dismiss = listener; return () => {} } }
    window.nodeTerminal = { ownerConfirmation: api } as unknown as typeof window.nodeTerminal
    await act(async () => root.render(<OwnerConfirmationHost />))
  })
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers() })

  it('requires an explicit click and cannot approve twice before React commits', async () => {
    vi.useFakeTimers()
    act(() => request(message()))
    expect(document.querySelector('.confirm__msg')?.textContent).toContain('Builder')
    expect(document.activeElement?.tagName).not.toBe('BUTTON')
    const buttons = [...document.querySelectorAll('button')]
    const confirm = buttons.find((button) => button.textContent === 'Change')!
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    act(() => confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    expect(api.decide).not.toHaveBeenCalled()
    await act(async () => { confirm.click(); confirm.click() })
    expect(api.decide).toHaveBeenCalledExactlyOnceWith({ id: 'one', token: 'token-one', proof: 'proof-one', answer: 'approve' })
    expect(hasOwnerConfirmation()).toBe(false)
  })

  it('refuses another modal while preserving the active decision and the canvas pending flags', async () => {
    const release = registerConfirmationBlocker(() => true)
    act(() => request(message('blocked')))
    expect(document.querySelector('.confirm-overlay')).toBeNull()
    expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({ id: 'blocked', answer: 'busy' }))
    release()
    act(() => { request(message()); request(message('second')) })
    expect(api.decide).toHaveBeenCalledWith(expect.objectContaining({ id: 'second', answer: 'busy' }))
    expect(hasOwnerConfirmation()).toBe(true)
    act(() => dismiss('second'))
    expect(hasOwnerConfirmation()).toBe(true)
    act(() => dismiss('one'))
    expect(hasOwnerConfirmation()).toBe(false)
  })

  it('uses a receipt-relative deadline despite client clock skew and never approves on expiry', async () => {
    vi.useFakeTimers()
    act(() => request({ ...message(), expiresAt: Date.now() - 60_000 }))
    expect(document.querySelector('.confirm-overlay')).not.toBeNull()
    await act(async () => { await vi.advanceTimersByTimeAsync(5000) })
    expect(document.querySelector('.confirm-overlay')).toBeNull()
    expect(hasOwnerConfirmation()).toBe(false)
    expect(api.decide).not.toHaveBeenCalled()
  })

  it('releases a connection epoch that arrives after the UI unmounts', async () => {
    act(() => root.unmount())
    root = createRoot(host)
    let connected!: (epoch: string) => void
    api.connect = vi.fn(() => new Promise<string>((resolve) => { connected = resolve }))
    act(() => root.render(<OwnerConfirmationHost />))
    act(() => root.unmount())
    await act(async () => connected('late'))
    expect(api.disconnect).toHaveBeenCalledWith('late')
    root = createRoot(host)
  })
})
