// @vitest-environment jsdom
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { mirrorLatest, useNodesEpoch } from './nodesEpoch'
import { pruneDanglingEdges } from './pruneDanglingEdges'

// Canvas's hook order cut down to the two prunes, with the real epoch hook and mirror. Real React
// with no act(): the order React drains an update and a pending passive effect IS the bug.
type N = { id: string }
type E = { id: string; source: string; target: string }
const edge = (source: string, target: string): E => ({ id: `${source}-${target}`, source, target })

let root: ReturnType<typeof createRoot> | null = null
let latest: { nodes: N[]; ropes: E[]; bridges: E[] } = { nodes: [], ropes: [], bridges: [] }
let api: { setNodes: (u: (n: N[]) => N[]) => void; setRopes: (u: (e: E[]) => E[]) => void; setBridges: (u: (e: E[]) => E[]) => void } | null = null
/** Runs once, in the commit after `arm`, before that commit's passive effects: a frame arriving there. */
let inCommit: (() => void) | null = null

function Canvas({ initial }: { initial: { nodes: N[]; ropes: E[]; bridges: E[] } }) {
  const [nodes, setNodes] = useState<N[]>(initial.nodes)
  const [bridges, setBridges] = useState<E[]>(initial.bridges)
  const [ropes, setRopes] = useState<E[]>(initial.ropes)
  const bridgesRef = useRef(bridges)
  const bridgesMirrored = useRef(bridges)
  const ropesRef = useRef(ropes)
  const ropesMirrored = useRef(ropes)
  const { nodesRef, nodesProjectIdRef, renderedProjectId } = useNodesEpoch(nodes)
  const inLatestEpoch = renderedProjectId === nodesProjectIdRef.current
  mirrorLatest(bridges, bridgesMirrored, bridgesRef, inLatestEpoch)
  mirrorLatest(ropes, ropesMirrored, ropesRef, inLatestEpoch)
  latest = { nodes, ropes, bridges }
  api = { setNodes, setRopes, setBridges }
  useEffect(() => { pruneDanglingEdges(nodesRef, ropesRef, setRopes) }, [nodes])
  useEffect(() => { pruneDanglingEdges(nodesRef, bridgesRef, setBridges) }, [bridges, nodes])
  useLayoutEffect(() => {
    const run = inCommit
    inCommit = null
    run?.()
  })
  return null
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setTimeout(resolve, 5))
}
const mount = async (nodes: N[], ropes: E[] = [], bridges: E[] = []): Promise<void> => {
  root = createRoot(document.createElement('div'))
  root.render(<Canvas initial={{ nodes, ropes, bridges }} />)
  await settle()
}

afterEach(() => {
  root?.unmount()
  root = null
  inCommit = null
})

it('keeps a node, rope and bridge added between a commit and its pending prune effects', async () => {
  // A canvas that already holds edges: a prune with nothing to look at would not run at all.
  await mount([{ id: 'source' }, { id: 'other' }], [edge('source', 'other')], [edge('source', 'other')])
  // This commit's prune effects are still pending when the add is queued, so they are flushed ahead
  // of the next render and queue behind the add. That is how a burst of opens lost its edges.
  // A microtask, not the layout effect itself: updates made there run at sync priority and render
  // ahead of the prune, while a frame arriving from outside has the same priority as the prune.
  inCommit = () => {
    queueMicrotask(() => {
      api!.setNodes((n) => [...n, { id: 'opened' }])
      api!.setRopes((e) => [...e, edge('source', 'opened')])
      api!.setBridges((e) => [...e, edge('source', 'opened')])
    })
  }
  api!.setNodes((n) => [...n])
  await settle()

  expect(latest.nodes.map((n) => n.id)).toEqual(['source', 'other', 'opened'])
  expect(latest.ropes).toEqual([edge('source', 'other'), edge('source', 'opened')])
  expect(latest.bridges).toEqual([edge('source', 'other'), edge('source', 'opened')])
})

it('removes an edge whose node has gone, and leaves its neighbours', async () => {
  await mount(
    [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    [edge('a', 'b'), edge('b', 'c')],
    [edge('a', 'c'), edge('a', 'b')]
  )
  api!.setNodes((n) => n.filter((x) => x.id !== 'c'))
  await settle()

  expect(latest.ropes).toEqual([edge('a', 'b')])
  expect(latest.bridges).toEqual([edge('a', 'b')])
})

it('asks for no update when nothing dangles, so a drag frame costs no render', () => {
  let updates = 0
  pruneDanglingEdges(
    { current: [{ id: 'a' }, { id: 'b' }] },
    { current: [edge('a', 'b')] },
    () => { updates++ }
  )
  expect(updates).toBe(0)
})
