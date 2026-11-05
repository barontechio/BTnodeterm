import { expect, it, vi } from 'vitest'
import { LocalDevelopmentAuthority } from './development-preview-authority'
import type { DevPortsReport } from '../shared/dev-ports'

it('keeps cancelled discovery in the global bound until its underlying scan settles', async () => {
  const finish: ((report: DevPortsReport) => void)[] = []
  const collect = vi.fn(() => new Promise<DevPortsReport>(resolve => finish.push(resolve)))
  const execution = { socket: 'node-terminal', socketPath: '/test', server: '1:1', session: 'nt-n', sessionId: '$1', paneId: '%1', panePid: 1, paneBirth: '1', clientPid: 2, clientBirth: '2', current: () => true }
  const authority = new LocalDevelopmentAuthority({
    approved: [{ projectId: 'p', nodeId: 'n', port: 3000, argv: ['node', '/app/vite.js'] }],
    tmuxBin: () => 'tmux', ownerCurrent: () => true, execution: async () => execution,
    current: () => true, managementPorts: () => [], collect
  })
  const pending = Array.from({ length: 4 }, (_, i) => authority.list(String(i), { projectId: 'p', nodeId: 'n' }).catch(() => []))
  await Promise.resolve(); await Promise.resolve()
  authority.forgetOwner('0')
  await expect(authority.list('new', { projectId: 'p', nodeId: 'n' })).rejects.toThrow('busy')
  expect(collect).toHaveBeenCalledTimes(4)
  for (const resolve of finish) resolve({ ok: false, reason: 'unreachable', nodes: {} })
  await Promise.all(pending)
  authority.stop()
})

it('retains the original execution across awaited listener and accepted-socket proofs', async () => {
  const linux = await import('./development-preview-linux')
  const proof = { nodeId: 'n', socket: 'node-terminal', session: 'nt-n', panePid: 10, pid: 11,
    port: 3000, address: '127.0.0.1', birth: '11', paneBirth: '10', inode: '20', argv: ['node', '/app/vite.js'] }
  const makeExecution = () => ({ socket: 'node-terminal', socketPath: '/test', server: '1:1',
    session: 'nt-n', sessionId: '$1', paneId: '%1', panePid: 10, paneBirth: '10',
    clientPid: 2, clientBirth: '2', current: () => true })
  let execution = makeExecution()
  const listener = vi.spyOn(linux, 'proveLinuxListener').mockResolvedValue(proof)
  const connected = vi.spyOn(linux, 'proveLinuxConnection').mockResolvedValue(true)
  const authority = new LocalDevelopmentAuthority({
    approved: [{ projectId: 'p', nodeId: 'n', port: 3000, argv: proof.argv }],
    tmuxBin: () => 'tmux', ownerCurrent: () => true, execution: async () => execution,
    current: (_scope, expected) => expected === execution, managementPorts: () => [],
    collect: async options => { options.observe?.(proof); return { ok: true, nodes: {} } }
  })
  const scope = { projectId: 'p', nodeId: 'n' }
  try {
    let release!: () => void
    const paused = new Promise<void>(resolve => { release = resolve })
    listener.mockImplementationOnce(async () => { await paused; return proof })
    const listing = authority.list('owner', scope)
    await vi.waitFor(() => expect(listener).toHaveBeenCalledOnce())
    execution = makeExecution(); release()
    await expect(listing).rejects.toThrow('scope changed')
    const [record] = await authority.list('owner', scope)
    expect(record).toBeDefined()
    const proving = new Promise<void>(resolve => { release = resolve })
    listener.mockImplementationOnce(async () => { await proving; return proof })
    const resolving = authority.resolve('owner', record.id)
    await Promise.resolve(); await Promise.resolve()
    execution = makeExecution(); release()
    expect(await resolving).toBeNull()
    expect(authority.current('owner', record.id)).toBe(false)
    const [next] = await authority.list('owner', scope)
    const accepting = new Promise<void>(resolve => { release = resolve })
    connected.mockImplementationOnce(async () => { await accepting; return true })
    const connection = authority.connected('owner', next.id, {} as import('node:net').Socket)
    await vi.waitFor(() => expect(connected).toHaveBeenCalledOnce())
    execution = makeExecution(); release()
    expect(await connection).toBe(false)
  } finally { authority.stop(); listener.mockRestore(); connected.mockRestore() }
})
