import { readFileSync } from 'node:fs'
import path from 'node:path'
import { transformSync } from 'esbuild'
import { describe, expect, it, vi } from 'vitest'
import { captureNotificationTarget } from './browserNotificationTarget'
import type { NodeTerminalApi } from '@shared/types'
import type { WorkspaceSession } from '../session/session'

// Execute the actual Canvas routing closure without mounting its terminal/PTY tree. Keeping
// the UI effects as spies exposes the interval between installing an epoch and Flow landing.
const canvas = readFileSync(path.join(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
const start = canvas.indexOf('  notificationRouterRef.current = (source, payload) => {')
const end = canvas.indexOf('  useEffect(() => {', start)
if (start < 0 || end < start) throw new Error('Canvas notification router was not found')
const code = transformSync(canvas.slice(start, end), { loader: 'ts', target: 'es2022' }).code

function fixture(landed = false) {
  const source = {} as NodeTerminalApi
  const session = { id: 'session', api: source, status: 'connected', source: 'local', label: 'Owner' } as WorkspaceSession
  const store = { activeProjectId: 'B', getProject: () => ({ closed: false }) }
  const notificationRouterRef: { current?: (api: NodeTerminalApi, payload: { nodeId: string }) => {
    current(): boolean; focus(current: () => boolean): void
  } } = {}
  const pendingFocusRef: { current: null | { nodeId: string; current(): boolean } } = { current: null }
  const focusNodeById = vi.fn()
  const flowLanding = { holds: vi.fn(() => landed) }
  const nodesProjectIdRef = { current: 'B' }
  const deps = {
    notificationRouterRef, captureNotificationTarget,
    notificationMembership: () => [{ projectId: 'B', nodeId: 'n', session }],
    nodesProjectIdRef, nodesRef: { current: [{ id: 'n' }] },
    useProjects: { getState: () => store }, focusNodeById, flowLanding, pendingFocusRef,
    reopenProject: vi.fn(async () => true), switchProject: vi.fn()
  }
  new Function(...Object.keys(deps), code)(...Object.values(deps))
  const target = notificationRouterRef.current!(source, { nodeId: 'n' })
  return { target, pendingFocusRef, focusNodeById, flowLanding, session, nodesProjectIdRef }
}

describe('browser notification Canvas landing', () => {
  it('keeps a guarded pending focus when epoch is installed but Flow has not landed', () => {
    const f = fixture()
    f.target.focus(f.target.current)
    expect(f.focusNodeById).not.toHaveBeenCalled()
    expect(f.pendingFocusRef.current?.nodeId).toBe('n')
    expect(f.pendingFocusRef.current?.current()).toBe(true)
    // The existing load-effect landing consumes this request; it must retain its source guard.
    f.session.status = 'offline'
    expect(f.pendingFocusRef.current?.current()).toBe(false)
  })
  it('focuses an already-landed project immediately', () => {
    const f = fixture(true)
    f.target.focus(f.target.current)
    expect(f.focusNodeById).toHaveBeenCalledExactlyOnceWith('n')
    expect(f.pendingFocusRef.current).toBeNull()
  })
  it('invalidates queued focus when its installed project changes', () => {
    const f = fixture()
    f.target.focus(f.target.current)
    f.nodesProjectIdRef.current = 'A'
    expect(f.pendingFocusRef.current?.current()).toBe(false)
  })
})
