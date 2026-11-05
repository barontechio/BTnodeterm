import { describe, it, expect, vi } from 'vitest'
import type { NodeTerminalApi } from '@shared/types'
import { branchClaudeSession } from './claudeBranch'

const fakeApi = (branchClaude?: unknown) => {
  const sendText = vi.fn(); const capture = vi.fn()
  return { api: { control: { branchClaude }, pty: { sendText, capture } } as unknown as NodeTerminalApi, sendText, capture }
}

describe('branchClaudeSession', () => {
  it('requires host support without a raw input or capture fallback', async () => {
    const f = fakeApi()
    expect(await branchClaudeSession(f.api, 'node-1')).toMatchObject({ ok: false })
    expect(f.capture).not.toHaveBeenCalled(); expect(f.sendText).not.toHaveBeenCalled()
  })
  it('returns the host durable-node result through the passed session api', async () => {
    const reply = { ok: true, newNodeId: 'resume-node' }; const branch = vi.fn(async () => reply)
    const f = fakeApi(branch)
    expect(await branchClaudeSession(f.api, 'node-1', { x: 10, y: 20 })).toBe(reply)
    expect(branch).toHaveBeenCalledWith('node-1', { x: 10, y: 20 })
    expect(f.capture).not.toHaveBeenCalled(); expect(f.sendText).not.toHaveBeenCalled()
  })

  it('does not repeat a branch after a lost reply', async () => {
    const branch = vi.fn(async () => { throw new Error('reply lost') }); const f = fakeApi(branch)
    expect(await branchClaudeSession(f.api, 'node-1')).toMatchObject({ ok: false, error: expect.stringContaining('before repeating') })
    expect(branch).toHaveBeenCalledOnce()
    expect(f.capture).not.toHaveBeenCalled(); expect(f.sendText).not.toHaveBeenCalled()
  })
})
