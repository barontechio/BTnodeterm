import { expect, it } from 'vitest'
import { hostGroupedOpenRoute } from './group-control-route'
import type { Workspace } from '../shared/types'

const workspace = { version: 2, projects: [
  { id: 'local', nodes: [{ id: 'source', kind: 'terminal' }] },
  { id: 'ssh', ssh: { host: 'remote' }, nodes: [{ id: 'remote-source', kind: 'terminal' }] }
] } as Workspace
const route = (args: Record<string, string>, extra: Partial<Parameters<typeof hostGroupedOpenRoute>[0]> = {}) =>
  hostGroupedOpenRoute({ verb: 'open-agent', args, workspace, sourceNodeId: 'source', hostPlatform: 'linux', ...extra })

it('routes local headless grouped opens to the host without taking over Desktop remote/custom adapters', () => {
  expect(route({ agent: 'codex', group: 'g' })).toBe('host')
  expect(route({ agent: 'codex', group: 'g', project: 'ssh' })).toBe('renderer')
  expect(route({ agent: 'codex', group: 'g' }, { sourceNodeId: 'remote-source' })).toBe('renderer')
  expect(route({ agent: 'custom', group: 'g' })).toBe('renderer')
  expect(route({ agent: 'custom', group: 'g' }, { verb: 'open-claude' })).toBe('host')
  expect(route({ agent: 'codex', group: 'g' }, { hostPlatform: 'win32' })).toBe('renderer')
  expect(route({ agent: 'codex', group: 'g' }, { sourceNodeId: 'unknown' })).toBe('host')
})

it('never silently drops an explicit reservation on an unsupported or malformed open', () => {
  expect(route({ reservation: 'slot' })).toBe('host')
  expect(route({ agent: 'custom', group: 'g', reservation: 'slot' })).toBe('host')
  expect(route({ group: 'g', reservation: 'slot' }, { hostPlatform: 'win32' })).toBe('unsupported-shell')
  expect(route({ group: 'g' }, { verb: 'rename' })).toBe('renderer')
})
