import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { OwnerConfirmationBroker, registerOwnerConfirmationIpc, type ConfirmationIntent } from './owner-confirmation'
import { IPC } from '../shared/ipc'
import { CONTROL_REQUEST_TIMEOUT_MS } from '../shared/control-confirm'
import type { OwnerConfirmation, OwnerConfirmationAnswer } from '../shared/owner-confirmation'

describe('host owner confirmation broker', () => {
  let platform: FakePlatform
  let broker: OwnerConfirmationBroker
  let owners: Set<number>
  const intent = (nodeId = 'agent'): ConfirmationIntent => ({ action: 'settings',
    requester: { nodeId, projectId: 'p', title: 'Builder' },
    binding: { normalizedArgs: { set: 'gridSize', value: 24 }, target: { projectId: 'p', session: 's1', account: 'a' }, policy: 'creator' },
    message: 'Set the grid to 24 px?', confirmLabel: 'Change', checkCurrent: async () => true })
  const messages = (id: number) => platform.sent.filter((message) => message.to === id && message.channel === IPC.ownerConfirmationRequest).map((message) => message.args[0] as OwnerConfirmation)
  const answer = (request: OwnerConfirmation, response: OwnerConfirmationAnswer['answer'] = 'approve'): OwnerConfirmationAnswer =>
    ({ id: request.id, token: request.token, proof: request.proof, answer: response })
  beforeEach(() => {
    owners = new Set([1, 2]); platform = fakePlatform({ isOwnerClient: (id) => owners.has(id) })
    platform.clients.push(1, 2, 3)
    broker = new OwnerConfirmationBroker(platform)
    registerOwnerConfirmationIpc(platform, broker)
  })
  afterEach(() => { broker.dispose(); vi.useRealTimers() })

  it('requires an attached owner UI and performs no effect when none is available', async () => {
    expect(await broker.request(intent())).toEqual({ ok: false, reason: 'owner-unavailable' })
    expect(() => broker.connect(3)).toThrow('owner-required')
    expect(platform.sent).toEqual([])
    expect(platform.handlers[IPC.ownerConfirmationDecide](1, { id: 'forged', answer: 'approve' })).toBe(false)
  })

  it('binds per-client tokens and a host proof; two tabs can approve only one execution', async () => {
    broker.connect(1); broker.connect(2)
    const requested = broker.request(intent())
    const first = messages(1)[0]; const second = messages(2)[0]
    expect(first.id).toBe(second.id); expect(first.token).not.toBe(second.token)
    expect(broker.decide(2, answer(first))).toBe(false)
    expect(broker.decide(1, { ...answer(first), proof: 'changed target' })).toBe(false)
    expect(broker.decide(1, answer(first))).toBe(true)
    expect(broker.decide(2, answer(second))).toBe(false)
    const permit = await requested
    expect(permit.ok).toBe(true)
    if (!permit.ok) throw new Error('expected permit')
    expect(await permit.consume()).toBe(true); expect(await permit.consume()).toBe(false)
    expect(broker.decide(1, answer(first))).toBe(false)
    expect(platform.sent.filter((message) => message.channel === IPC.ownerConfirmationDismiss).map((message) => message.to).sort()).toEqual([1, 2])
  })

  it('does not transfer a pending decision to a reconnected or reloaded UI', async () => {
    const old = broker.connect(1); broker.connect(2)
    const requested = broker.request(intent())
    const first = messages(1)[0]; const second = messages(2)[0]
    const current = broker.connect(1)
    broker.disconnect(1, old)
    expect(broker.decide(1, answer(first))).toBe(false)
    expect(broker.decide(2, answer(second, 'deny'))).toBe(true)
    expect(await requested).toEqual({ ok: false, reason: 'denied' })
    const next = broker.request(intent())
    broker.disconnect(1, current); broker.forgetClient(2)
    expect(await next).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('invalidates an approved but unconsumed permit on logout, departure and cancellation', async () => {
    for (const revoke of [() => owners.delete(1), () => broker.forgetClient(1)]) {
      owners.add(1); broker.connect(1)
      const requested = broker.request(intent())
      broker.decide(1, answer(messages(1).at(-1)!))
      const permit = await requested
      expect(permit.ok).toBe(true)
      revoke()
      if (permit.ok) expect(await permit.consume()).toBe(false)
    }
    owners.add(1); broker.connect(1)
    const requested = broker.request(intent())
    broker.decide(1, answer(messages(1).at(-1)!))
    const permit = await requested
    if (!permit.ok) throw new Error('expected permit')
    permit.cancel(); expect(await permit.consume()).toBe(false)
  })

  it('expires unanswered and approved permits and refuses late replay', async () => {
    vi.useFakeTimers(); broker.dispose(); broker = new OwnerConfirmationBroker(platform, () => Date.now()); broker.connect(1)
    const requested = broker.request(intent())
    const message = messages(1)[0]
    await vi.advanceTimersByTimeAsync(CONTROL_REQUEST_TIMEOUT_MS)
    expect(await requested).toEqual({ ok: false, reason: 'expired' })
    expect(broker.decide(1, answer(message))).toBe(false)
    const next = broker.request(intent()); broker.decide(1, answer(messages(1).at(-1)!))
    const permit = await next
    await vi.advanceTimersByTimeAsync(CONTROL_REQUEST_TIMEOUT_MS)
    if (permit.ok) expect(await permit.consume()).toBe(false)
  })

  it('lets other intents proceed while one waits, bounds duplicate requests and never treats busy as consent', async () => {
    broker.connect(1); broker.connect(2)
    const first = broker.request(intent('first'))
    expect(await broker.request(intent('first'))).toEqual({ ok: false, reason: 'busy' })
    const second = broker.request(intent('second'))
    const request = messages(1).at(-1)!
    broker.decide(1, answer(request))
    const permit = await second
    if (!permit.ok) throw new Error('expected independent permit')
    expect(await permit.consume()).toBe(true)
    broker.decide(1, answer(messages(1)[0], 'busy'))
    broker.decide(2, answer(messages(2)[0], 'busy'))
    expect(await first).toEqual({ ok: false, reason: 'busy' })
  })

  it('rechecks the exact target and policy after approval, and serializes competing permit consumers', async () => {
    broker.connect(1)
    let session = 's1'
    const requested = broker.request({ ...intent(), checkCurrent: async () => session === 's1' })
    broker.decide(1, answer(messages(1)[0]))
    const permit = await requested
    session = 'replacement'
    if (!permit.ok) throw new Error('expected decision')
    expect(await permit.consume()).toBe(false)

    let finish!: (valid: boolean) => void
    const next = broker.request({ ...intent(), checkCurrent: () => new Promise<boolean>((resolve) => { finish = resolve }) })
    broker.decide(1, answer(messages(1).at(-1)!))
    const approved = await next
    if (!approved.ok) throw new Error('expected decision')
    const first = approved.consume()
    expect(await approved.consume()).toBe(false)
    finish(true)
    expect(await first).toBe(true)
  })

  it('fails closed when the proof read fails or its owner leaves during that read', async () => {
    broker.connect(1)
    const requested = broker.request({ ...intent(), checkCurrent: async () => { throw new Error('workspace unreadable') } })
    broker.decide(1, answer(messages(1)[0]))
    const permit = await requested
    if (!permit.ok) throw new Error('expected decision')
    expect(await permit.consume()).toBe(false)
    let finish!: (valid: boolean) => void
    const next = broker.request({ ...intent(), checkCurrent: () => new Promise<boolean>((resolve) => { finish = resolve }) })
    broker.decide(1, answer(messages(1).at(-1)!))
    const approved = await next
    if (!approved.ok) throw new Error('expected decision')
    const checking = approved.consume()
    broker.forgetClient(1); finish(true)
    expect(await checking).toBe(false)
  })
})
