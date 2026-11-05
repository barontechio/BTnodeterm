// One pure command planner for Desktop and host-side geometry automation.
import {
  ungroupNodes, reparentNode, fitGroupToChildren, resizeNodes, placeNodes, arrangeNodes,
  alignNodes, commonParentId, fitAncestorChain, groupArrangeRefusal, arrangeGroupChildren,
  tidyCanvas, arrangeByLineage, lineageLayers, type GeometryNode
} from './canvas-geometry'
import { arrangeArgsRefusal, isTopLevelGroupArg, parseArrangeGap, TOP_ARRANGE_LAYOUTS, GROUP_ARRANGE_LAYOUTS } from './arrange-verb'
import { geometryArgsRefusal, parseResizeArgs, parsePlaceArgs } from './geometry-verbs'
import { placeReply, resizeReply } from './geometry-reply'
import { markLegacyWaitRopes } from './canvas-lineage'

export const GEOMETRY_CONTROL_VERBS = ['ungroup', 'move', 'resize', 'place', 'arrange', 'align'] as const
export type GeometryControlVerb = typeof GEOMETRY_CONTROL_VERBS[number]

export interface GeometryControlReply {
  ok: boolean
  error?: string
  message?: string
  result?: Record<string, unknown>
}

export function planGeometryCommand<N extends GeometryNode>(
  verb: GeometryControlVerb,
  args: Record<string, string>,
  nodes: N[],
  options: { grid?: number; edges?: readonly { id: string; source: string; target: string }[] } = {}
): { nodes: N[]; changed: boolean; reply: GeometryControlReply } {
  const shape = geometryArgsRefusal(verb, args)
  if (shape) return { nodes, changed: false, reply: { ok: false, error: shape } }
  let planned = nodes
  let answer: GeometryControlReply = { ok: false, error: `${verb}: unsupported geometry command` }
  const ctlNodes = () => nodes
  const snapGridNow = () => options.grid ?? 0
  const commitCtlNodes = (next: N[]) => { planned = next }
  const reply = (value: GeometryControlReply) => { answer = value }
  const dispatch = (): void => {
    switch (verb) {
      case 'ungroup': {
        const gid = (args.group ?? '').trim()
        const live = ctlNodes()
        const frame = live.find((nd) => nd.id === gid && nd.type === 'group')
        if (!frame) {
          reply({ ok: false, error: `ungroup: --group names no group frame (${gid || 'missing'})` })
          return
        }
        const freed = live.filter((nd) => nd.parentId === gid).map((nd) => nd.id)
        commitCtlNodes(ungroupNodes(live, gid))
        reply({ ok: true, message: `ungrouped ${gid}, freed ${freed.length} node(s)`, result: { freed } })
        return
      }
      case 'move': {
        // Reparent nodes — or whole frame subtrees — INTO an existing frame (or out to the
        // top level): the one way to move a node OUT of its current frame, which `group`
        // deliberately won't do. `reparentNode` keeps each node's ROOT-space position fixed
        // and refuses a cycle (a frame into itself or its own descendant).
        const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const live = ctlNodes()
        const rawTarget = (args.group ?? '').trim().toLowerCase()
        const toTop = !rawTarget || rawTarget === 'top' || rawTarget === 'none' || rawTarget === 'ungrouped'
        const targetGroup = toTop ? null : args.group!.trim()
        if (targetGroup && !live.some((nd) => nd.id === targetGroup && nd.type === 'group')) {
          reply({ ok: false, error: `move: --group names no group frame (${targetGroup})` })
          return
        }
        let next = live
        const moved: string[] = []
        for (const id of ids) {
          const before = next
          const nd = next.find((n) => n.id === id)
          // Skip an unknown id, a node already in the requested container, or a cycle.
          if (nd) next = reparentNode(next, id, targetGroup)
          if (next !== before) moved.push(id)
        }
        if (moved.length === 0) {
          reply({ ok: false, error: 'move: nothing moved (unknown ids, already there, or an invalid group cycle)' })
          return
        }
        // The source frame(s) the nodes LEFT, and the destination, may now be the wrong size —
        // hug whatever each ends up holding so no oversized/updated box is left behind.
        const affected = new Set<string>()
        if (targetGroup) affected.add(targetGroup)
        for (const id of moved) {
          const was = live.find((n) => n.id === id)
          if (was?.parentId) affected.add(was.parentId)
        }
        for (const g of affected) {
          if (next.some((n) => n.parentId === g)) next = fitGroupToChildren(next, g, snapGridNow())
        }
        commitCtlNodes(next)
        const where = targetGroup ? `into ${targetGroup}` : 'to the top level'
        reply({ ok: true, message: `moved ${moved.length} node(s) ${where}`, result: { moved, group: targetGroup } })
        return
      }
      case 'resize': {
        // Size existing nodes (issue #1288). The rules — kind minimum and canvas maximum, frames
        // refused, collapsed/maximized handled, ancestor frames re-fitted — are all
        // `resizeNodes`; this case only parses, writes on a change and says what was applied.
        const req = parseResizeArgs(args)
        if ('error' in req) {
          reply({ ok: false, error: req.error })
          return
        }
        const live = ctlNodes()
        const out = resizeNodes(live, req.ids, { width: req.width, height: req.height }, snapGridNow())
        if (!out.ok) {
          reply({ ok: false, error: out.error })
          return
        }
        // The SAME array means every node already had that size: an answer, nothing to write.
        if (out.nodes !== live) commitCtlNodes(out.nodes)
        reply({ ok: true, ...resizeReply(out, out.nodes !== live) })
        return
      }
      case 'place': {
        // Put nodes at canvas coordinates, or shift them (issue #1288). NOT a flag on `move`:
        // without `--group`, `move` takes a node out of its frame. `placeNodes` keeps the parent,
        // converts root space to parent-relative and re-fits the frames around what moved.
        const req = parsePlaceArgs(args)
        if ('error' in req) {
          reply({ ok: false, error: req.error })
          return
        }
        const live = ctlNodes()
        const out = placeNodes(live, req.ids, req, snapGridNow())
        if (!out.ok) {
          reply({ ok: false, error: out.error })
          return
        }
        if (out.nodes !== live) commitCtlNodes(out.nodes)
        reply({ ok: true, ...placeReply(out, req, out.nodes !== live) })
        return
      }
      case 'arrange':
      case 'align': {
        const live = ctlNodes()
        // The flag shape was refused in main (`arrangeArgsRefusal`); this is the belt. With it,
        // `--layout` on the `--group` form is absent or a known word by the time it is read
        // below — an unknown one is refused by name, never delivered as a grid.
        const shapeRefusal = verb === 'arrange' ? arrangeArgsRefusal(args) : null
        if (shapeRefusal) {
          reply({ ok: false, error: shapeRefusal })
          return
        }
        // `--gap` (issue #1288), well-formed by now (the gate above): every arrange form passes it
        // on; absent stays `undefined`, so each transform keeps its own default. `align` has none.
        const parsedGap = parseArrangeGap(args.gap)
        const gap = 'gap' in parsedGap ? parsedGap.gap : undefined
        // `arrange --group <frameId>`: name the FRAME instead of listing its children. The
        // whole rule set is `arrangeGroupChildren` — the same transform the frame's menu rows
        // and the palette run — so this branch only parses, refuses by name and replies.
        if (verb === 'arrange' && args.group) {
          const gid = args.group.trim()
          // Off canvas the lineage ropes are the OWNING project's, not the live canvas's — and a
          // stored file may predate the wait mark, so it is re-marked exactly as a load would.
          // The rope id rides along: it is what tells a wait from an opener.
          const edges = markLegacyWaitRopes(options.edges ?? [])
          // `arrange --group top`: the user's Tidy canvas (or its lineage bands), on the canvas
          // that owns the caller — the same pure transforms the pane menu runs.
          if (isTopLevelGroupArg(gid)) {
            const topLayout = TOP_ARRANGE_LAYOUTS.find((l) => l === args.layout) ?? 'tidy'
            const next = topLayout === 'lineage' ? arrangeByLineage(live, edges, { gap }) : tidyCanvas(live, edges, { gap })
            const count = live.filter((nd) => !nd.parentId).length
            if (next !== live) commitCtlNodes(next)
            reply({
              ok: true,
              message:
                next !== live
                  ? `arranged ${count} top-level item(s) as ${topLayout}`
                  : count < 2
                    ? 'fewer than two top-level items — nothing to arrange'
                    : topLayout === 'lineage' && lineageLayers(live, edges).layers.length === 0
                      ? 'no opened-by or --after connection joins two top-level items — nothing moved'
                      : `the canvas is already arranged as ${topLayout} — nothing moved`,
              result: { count, group: 'top', layout: topLayout, changed: next !== live }
            })
            return
          }
          const groupLayout = GROUP_ARRANGE_LAYOUTS.find((l) => l === args.layout) ?? 'grid'
          const refusal = groupArrangeRefusal(live, gid, groupLayout, edges)
          if (refusal) {
            reply({ ok: false, error: `arrange: ${refusal}` })
            return
          }
          const cols = args.cols ? parseInt(args.cols, 10) || undefined : undefined
          const next = arrangeGroupChildren(live, gid, { layout: groupLayout, cols, gap, edges, grid: snapGridNow() })
          const count = live.filter((nd) => nd.parentId === gid).length
          // The SAME array means every item already sat where the layout puts it: an answer,
          // not a failure — and nothing to write.
          if (next !== live) commitCtlNodes(next)
          const frame = next.find((nd) => nd.id === gid)
          reply({
            ok: true,
            message:
              next === live
                ? `group ${gid} is already arranged as ${groupLayout} — nothing moved`
                : `arranged ${count} item(s) in group ${gid} as ${groupLayout} and resized the frame to fit`,
            result: {
              count,
              group: gid,
              layout: groupLayout,
              changed: next !== live,
              width: frame?.width,
              height: frame?.height
            }
          })
          return
        }
        const ids = (args.nodes ?? '').split(',').map((s) => s.trim()).filter(Boolean)
        const edge = (['left', 'right', 'top', 'bottom', 'hcenter', 'vcenter'] as const).find((e2) => e2 === args.edge)
        if (verb === 'align' && !edge) {
          reply({ ok: false, error: 'align requires --edge left|right|top|bottom|hcenter|vcenter' })
          return
        }
        // arrange/align run in ONE coordinate space: all top-level, or all children of one
        // frame. A mixed set (framed + loose, or two frames) is refused with a clear reason
        // rather than the old misleading "none are top-level".
        const container = commonParentId(live, ids)
        if (container === undefined) {
          const known = ids.filter((id) => live.some((n) => n.id === id))
          reply({
            ok: false,
            error: known.length === 0
              ? `${verb}: none of the given node ids exist`
              : `${verb}: the nodes are in different containers — arrange the children of one frame (or top-level nodes) at a time`
          })
          return
        }
        const layout = (['grid', 'row', 'column'] as const).find((l) => l === args.layout) ?? 'grid'
        const cols = args.cols ? parseInt(args.cols, 10) || undefined : undefined
        let next = verb === 'arrange'
          ? arrangeNodes(live, ids, { layout, cols, gap })
          : alignNodes(live, ids, edge!)
        // Tidying a frame's children usually leaves the frame the wrong size (it was sized to
        // their old scattered spots) — hug the new layout, and re-fit every ANCESTOR frame too:
        // a nested frame that grew past its parent would be clamped by `extent:'parent'` into
        // an inverted range. Top-level sets have no frame.
        if (container) next = fitAncestorChain(next, container, snapGridNow())
        commitCtlNodes(next)
        const how = verb === 'arrange' ? `as ${layout}` : `to ${edge}`
        reply({ ok: true, message: `${verb === 'arrange' ? 'arranged' : 'aligned'} ${ids.length} node(s) ${how}`, result: { count: ids.length, container } })
        return
      }
    }
  }
  dispatch()
  return answer.ok
    ? { nodes: planned, changed: planned !== nodes, reply: answer }
    : { nodes, changed: false, reply: answer }
}
