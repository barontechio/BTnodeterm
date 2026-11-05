import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PassphrasePrompts, type PassphraseRecipient } from './passphrase-prompts'
import { OwnerLifetimes } from '../owner-lifetimes'
import type { SshPassphraseRequest } from '../../shared/types'

describe('shared owner-bound passphrase delivery', () => {
  let prompts: PassphrasePrompts
  let owners: OwnerLifetimes
  let recipient: PassphraseRecipient
  let requests: SshPassphraseRequest[]
  let dismiss: ReturnType<typeof vi.fn<(id: string) => void>>
  beforeEach(() => {
    prompts = new PassphrasePrompts(); owners = new OwnerLifetimes(); requests = []; dismiss = vi.fn()
    recipient = { owner: owners.get(1, () => true), request: (request) => { requests.push(request); return true }, dismiss }
  })
  afterEach(() => { prompts.dispose(); owners.dispose(); vi.useRealTimers() })
  const input = { identityFile: '/private/key', retry: false, target: 'user@host' }
  it('delivers only to its recipient and refuses a different connection, replay and oversized answers', async () => {
    const pending = prompts.request(input, recipient); const request = requests[0]
    expect(prompts.submit(owners.get(2, () => true), request.requestId, 'untrusted')).toBe(false)
    expect(prompts.submit(recipient.owner, request.requestId, 'x'.repeat(16 * 1024 + 1))).toBe(false)
    expect(prompts.submit(recipient.owner, request.requestId, 'secret-answer')).toBe(true)
    expect(await pending).toBe('secret-answer')
    expect(prompts.submit(recipient.owner, request.requestId, 'replay')).toBe(false)
    expect(JSON.stringify(requests)).not.toContain('secret-answer')
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(request.requestId)
  })
  it('releases an unanswered transport on disconnect and cannot accept the replacement connection', async () => {
    const pending = prompts.request(input, recipient); const request = requests[0]
    owners.forget(1)
    expect(await pending).toBeUndefined()
    expect(prompts.submit(owners.get(1, () => true), request.requestId, 'late')).toBe(false)
  })
  it('distinguishes explicit decline from expiry, no UI and failed delivery', async () => {
    const declined = prompts.request(input, recipient)
    prompts.submit(recipient.owner, requests[0].requestId, null)
    expect(await declined).toBeNull()
    expect(await prompts.request(input, null)).toBeUndefined()
    expect(await prompts.request(input, { ...recipient, request: () => { throw new Error('disposed UI') } })).toBeUndefined()
    vi.useFakeTimers({ toFake: ['Date'] })
    const expired = prompts.request(input, recipient); const request = requests.at(-1)!
    vi.setSystemTime(Date.now() + 301_000)
    expect(prompts.submit(recipient.owner, request.requestId, 'late')).toBe(false)
    expect(await expired).toBeUndefined()
  })
  it('bounds the pending queue and shutdown releases every transport', async () => {
    const waiting = Array.from({ length: 32 }, () => prompts.request(input, recipient))
    expect(await prompts.request(input, recipient)).toBeUndefined()
    prompts.dispose()
    expect(await Promise.all(waiting)).toEqual(Array(32).fill(undefined))
    expect(await prompts.request(input, recipient)).toBeUndefined()
  })
})
