import { describe, expect, it } from 'vitest'
import { LocalClaudeActionTarget, type LocalClaudeActionRuntime } from './local-claude-action-target'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Workspace } from '../shared/types'

function fixture() {
  const terminal = (id: string): CanvasNodeState => ({ id, kind: 'terminal', agentId: 'claude', title: id,
    group: null, color: '#000', position: { x: 0, y: 0 }, size: { width: 640, height: 440 } })
  const source = terminal('source'); const target = { ...terminal('target'), accountId: 'managed', agentSessionId: 'original' }
  const workspace: Workspace = { version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Fixture', cwd: '/repo',
    color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [source, target] }] }
  const settings = structuredClone(DEFAULT_SETTINGS)
  settings.claudeAccounts = [{ id: 'managed', label: 'Managed', configDir: '/owned/account', createdAt: 1 }]
  const runtime: LocalClaudeActionRuntime = { agentId: 'claude', sessionId: 'original', verified: true, state: 'done' }
  const lookups: string[] = []
  const guard = new LocalClaudeActionTarget({ settings: () => settings, runtime: (id) => id === 'target' ? runtime :
    { agentId: 'claude', sessionId: 'caller', verified: true }, scope: () => 'creator', ownsSpawn: () => true,
    stopped: () => false, handedOver: () => false, workspace: {
      load: async () => structuredClone(workspace), persistedCanvases: () => workspace.projects,
      projectTargetInfo: () => ({ cwd: '/repo', name: 'Fixture' }), getNodeForHostAction: (id) => {
        lookups.push(id)
        const node = workspace.projects[0].nodes.find((candidate) => candidate.id === id)
        return node ? structuredClone(node) : undefined
      }
    } })
  return { guard, workspace, target, runtime, settings, lookups }
}

describe('shared local Claude action target policy', () => {
  it('reads execution metadata only for the action endpoints on a large canvas', () => {
    const f = fixture()
    for (let index = 0; index < 1000; index++) f.workspace.projects[0].nodes.push({ ...f.target, id: `unrelated-${index}` })
    const before = f.guard.snapshot(f.workspace, 'source', 'target', true)
    expect(f.guard.snapshot(f.guard.cachedWorkspace('source', 'target'), 'source', 'target', true).binding).toBe(before.binding)
    expect(f.lookups.sort()).toEqual(['source', 'target'])
  })

  it('normalizes only the expected target session transition while retaining the other bindings', () => {
    const f = fixture(); const before = f.guard.snapshot(f.workspace, 'source', 'target', true)
    f.runtime.sessionId = 'new'; f.target.agentSessionId = 'new'
    const transition = { nodeId: 'target', runtimeSessionId: 'original', savedSessionId: 'original' }
    expect(f.guard.snapshot(f.workspace, 'source', 'target', false).binding).not.toBe(before.binding)
    expect(f.guard.snapshot(f.workspace, 'source', 'target', false, transition).binding).toBe(before.binding)
    f.target.cwd = '/different'
    expect(f.guard.snapshot(f.workspace, 'source', 'target', false, transition).binding).not.toBe(before.binding)
  })

  it('does not use an expected transition to skip held launches, runtime proof or saved-session changes', () => {
    const f = fixture(); const transition = { nodeId: 'target', runtimeSessionId: 'original', savedSessionId: 'original' }
    f.runtime.sessionId = 'new'; f.target.agentSessionId = 'another'
    expect(() => f.guard.snapshot(f.workspace, 'source', 'target', false, transition)).toThrow('outside the expected transition')
    f.target.agentSessionId = 'new'; f.runtime.verified = false
    expect(() => f.guard.snapshot(f.workspace, 'source', 'target', false, transition)).toThrow('verified')
    f.runtime.verified = true; f.target.pendingLaunch = { after: [], command: 'another launch' }
    expect(() => f.guard.snapshot(f.workspace, 'source', 'target', false, transition)).toThrow('held launch')
  })

  it('invalidates the binding when a linked account directory changes without an id change', () => {
    const f = fixture(); const before = f.guard.snapshot(f.workspace, 'source', 'target', true)
    f.settings.claudeAccounts[0].configDir = '/another/account'
    expect(f.guard.snapshot(f.workspace, 'source', 'target', true).binding).not.toBe(before.binding)
  })
})
