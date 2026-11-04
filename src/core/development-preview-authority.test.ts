import { expect, it, vi } from 'vitest'
import { LocalDevelopmentAuthority } from './development-preview-authority'
import type { DevPortsReport } from '../shared/dev-ports'

it('keeps cancelled discovery in the global bound until its underlying scan settles', async () => {
  const finish: ((report: DevPortsReport) => void)[] = []
  const collect = vi.fn(() => new Promise<DevPortsReport>(resolve => finish.push(resolve)))
  const execution = {}
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
