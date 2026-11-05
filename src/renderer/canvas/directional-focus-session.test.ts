import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { transformSync } from 'esbuild'
import { createAgentStatusSession } from '../state/agentStatus'
import { planDirectionalMove, isFocusTarget } from '../lib/directionalFocus'

// Execute the shipped focus callback against two real status stores containing the same node id.
// The hidden local copy must keep its unread state and must never acknowledge a relay focus.
const canvas = readFileSync(resolve(__dirname, 'Canvas.tsx'), 'utf8').replace(/\r\n/g, '\n')
const start = canvas.indexOf('const moveNodeFocus = useCallback(')
const end = canvas.indexOf('\n  /**', start)
const callback = canvas.slice(start, end).replace('const moveNodeFocus =', 'return')

describe('directional focus session ownership', () => {
  it.each(['relay', 'local'])('writes only the flow owner store when focusing %s', (owner) => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const ack = vi.fn()
    const local = createAgentStatusSession(undefined, ack)
    const relay = createAgentStatusSession()
    for (const session of [local, relay]) session.store.getState().markUnread('shared-node')
    const selectStore = vi.fn((project: string) => project === 'relay' ? relay : local)
    const deps = {
      useCallback: (fn: unknown) => fn,
      nodesRef: { current: [
        { id: 'old-node', type: 'terminal', position: { x: 0, y: 0 }, width: 300, height: 200 },
        { id: 'shared-node', type: 'terminal', position: { x: 400, y: 0 }, width: 300, height: 200 }
      ] },
      planDirectionalMove,
      useFocusNode: { getState: () => ({ focusedId: 'old-node', focus: vi.fn() }) },
      document: { activeElement: null }, FLOW_NODE_CLASS: 'node',
      isFocusTarget, viewCenter: () => null,
      focusNodeRef: { current: vi.fn() }, setNodes: vi.fn(),
      useTerminalFocus: { getState: () => ({ request: vi.fn() }) },
      useAgentStatus: local.store,
      agentStatusForProject: selectStore,
      flowOwnerProjectIdRef: { current: owner }
    }
    const compiled = transformSync(callback, { loader: 'ts', target: 'es2022' }).code
    const move = new Function(...Object.keys(deps), compiled)(...Object.values(deps))
    expect(move('right')).toBe(true)
    expect(selectStore).toHaveBeenCalledWith(owner)
    expect(relay.store.getState().byId['shared-node'].unread).toBe(owner !== 'relay')
    expect(local.store.getState().byId['shared-node'].unread).toBe(owner !== 'local')
    expect((owner === 'relay' ? relay : local).store.getState().activeId).toBe('shared-node')
    expect((owner === 'relay' ? local : relay).store.getState().activeId).toBeNull()
    expect(ack).toHaveBeenCalledTimes(owner === 'local' ? 1 : 0)
  })
})
