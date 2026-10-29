import { describe, expect, it } from 'vitest'
import { useHostTeamPlanner } from './team-control-route'
import { DEFAULT_SETTINGS, type CanvasNodeState, type Workspace } from '../shared/types'

const source: CanvasNodeState = { id: 'src', kind: 'terminal', agentId: 'claude', title: 'source',
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, color: '#0a84ff', group: null }
const workspace: Workspace = { version: 2, activeProjectId: 'unrelated', projects: [{ id: 'own', name: 'Own', color: '#0a84ff',
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [source] }] }
const base = { sourceNodeId: 'src', workspace, settings: DEFAULT_SETTINGS, hostPlatform: 'linux' }

describe('Desktop orchestration backend selection', () => {
  it('uses the caller project for supported local work and preserves native/remote backends', () => {
    const args = { team: '[{"agent":"claude","prompt":"task"}]' }
    expect(useHostTeamPlanner({ ...base, verb: 'spawn-team', args })).toBe(true)
    expect(useHostTeamPlanner({ ...base, verb: 'spawn-team', args, hostPlatform: 'win32' })).toBe(false)
    const remote = structuredClone(workspace); remote.projects[0].nodes[0].sshRemoteTmux = true
    expect(useHostTeamPlanner({ ...base, verb: 'spawn-team', args, workspace: remote })).toBe(false)
    expect(useHostTeamPlanner({ ...base, verb: 'spawn-team', args: { team: '[{"agent":"grok","prompt":"task"}]' } })).toBe(false)
    expect(useHostTeamPlanner({ ...base, verb: 'verify', args: { node: 'src' } })).toBe(true)
  })

  it('lets the host give source/grammar refusals without attempting a UI fallback', () => {
    expect(useHostTeamPlanner({ ...base, verb: 'spawn-team', args: { team: 'bad json' } })).toBe(true)
    expect(useHostTeamPlanner({ ...base, verb: 'verify', sourceNodeId: 'missing', args: { node: 'src' } })).toBe(true)
    expect(useHostTeamPlanner({ ...base, verb: 'verify', args: { node: 'src', project: 'other' } })).toBe(false)
  })
})
