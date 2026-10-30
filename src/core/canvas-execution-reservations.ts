import { createHash } from 'node:crypto'
import { stableStringify } from '../shared/canvas-mutations'
import { carryLocalNodeExec } from '../shared/node-exec'
import { descendantIds } from '../shared/worktree'
import type { CanvasMutation, CanvasNodeState, Project, Workspace } from '../shared/types'
import type { NodeExecutionBatchPermit } from './node-execution'
import type { ClientMutationRejection } from './canvas-sync'

type Location = Pick<Project, 'id' | 'cwd' | 'ssh' | 'storeInAppData' | 'closed' | 'remote' | 'handedOffTo'>
export function canvasExecutionBinding(project: Location, node: CanvasNodeState): string {
  return createHash('sha256').update(stableStringify({ project: { id: project.id, cwd: project.cwd,
    ssh: project.ssh, storeInAppData: project.storeInAppData === true, closed: project.closed === true,
    remote: project.remote === true, handedOffTo: project.handedOffTo }, id: node.id, kind: node.kind,
    parentId: node.parentId, agentId: node.agentId, agentModel: node.agentModel, accountId: node.accountId,
    cwd: node.cwd, ssh: node.ssh, sshRemoteTmux: node.sshRemoteTmux, sshFs: node.sshFs, worktree: node.worktree,
    runConfig: node.runConfig, filePath: node.filePath, fileMissing: node.fileMissing,
    agentSessionId: node.agentSessionId, shell: node.shell, pendingLaunch: node.pendingLaunch, clearEnv: node.clearEnv })).digest('hex')
}
interface Source {
  node(projectId: string, nodeId: string): CanvasNodeState | undefined
  project(projectId: string): Location | undefined
}
interface Held { project: Location; node: CanvasNodeState; binding: string; release: object }
const key = (projectId: string, nodeId: string) => `${projectId}\0${nodeId}`

/** Execution-metadata exclusion for a real host node claim. This grants no actor rights and
 * performs no disk/PTY work. Visual edits continue; conflicting optimistic edits get a canonical
 * correction. The caller retains this fence until its actual external operation settles.
 */
export class CanvasExecutionReservations {
  private held = new Map<string, Held>()
  constructor(private readonly source: Source) {}
  active(): boolean { return this.held.size > 0 }
  assertCurrent(): void {
    for (const target of this.held.values()) {
      const project = this.source.project(target.project.id)
      const node = this.source.node(target.project.id, target.node.id)
      if (!project || !node || canvasExecutionBinding(project, node) !== target.binding)
        throw new Error('canvas-execution-reserved: cached execution metadata changed')
    }
  }

  hold(workspace: Workspace, nodeIds: readonly string[], permit: NodeExecutionBatchPermit): { release(): void } {
    permit.assertCurrent()
    const ids = [...nodeIds]; const claimed = new Set(permit.nodeIds)
    if (!ids.length || new Set(ids).size !== ids.length || ids.length !== claimed.size || ids.some((id) => !claimed.has(id)))
      throw new Error('canvas-execution-claim-mismatch')
    if (this.held.size + ids.length > 32) throw new Error('canvas-execution-capacity')
    const selected = ids.map((id) => {
      const hits = workspace.projects.flatMap((project) => project.nodes.filter((node) => node.id === id).map((node) => ({ project, node })))
      if (hits.length !== 1 || hits[0].project.unavailable || hits[0].project.remote || hits[0].project.handedOffTo)
        throw new Error('canvas-execution-target-unavailable')
      const { project, node } = hits[0]
      if (workspace.projects.filter((candidate) => candidate.id === project.id).length !== 1)
        throw new Error('canvas-execution-target-unavailable')
      if (this.held.has(key(project.id, id))) throw new Error('canvas-execution-busy')
      if (node.kind === 'group' && [...descendantIds(project.nodes, id)].some((child) => !claimed.has(child)))
        throw new Error('canvas-execution-incomplete-group')
      return structuredClone({ project: { id: project.id, cwd: project.cwd, ssh: project.ssh,
        storeInAppData: project.storeInAppData, closed: project.closed, remote: project.remote,
        handedOffTo: project.handedOffTo }, node })
    })
    // No asynchronous boundary between validation and claiming the complete set.
    permit.assertCurrent(); const release = {}
    for (const target of selected) this.held.set(key(target.project.id, target.node.id), {
      ...target, binding: canvasExecutionBinding(target.project, target.node), release })
    return { release: () => { for (const [id, target] of this.held) if (target.release === release) this.held.delete(id) } }
  }

  assertProject(project: Location & Pick<Project, 'nodes' | 'unavailable'>): void {
    if (!this.held.size) return
    for (const target of this.held.values()) {
      if (target.project.id !== project.id) {
        if (project.nodes.some((node) => node.id === target.node.id))
          throw new Error('canvas-execution-reserved: node placement became ambiguous')
        continue
      }
      if (project.unavailable) throw new Error('canvas-execution-reserved: project availability changed')
      const matches = project.nodes.filter((node) => node.id === target.node.id)
      if (matches.length !== 1 || canvasExecutionBinding(project, matches[0]) !== target.binding)
        throw new Error('canvas-execution-reserved: execution metadata is completing another host action')
    }
    for (const node of project.nodes) {
      if (node.parentId && !this.held.has(key(project.id, node.id)) && this.held.has(key(project.id, node.parentId)))
        throw new Error('canvas-execution-reserved: cannot add members to a reserved group')
    }
  }
  assertWorkspace(workspace: Workspace): void {
    if (!this.held.size) return
    for (const target of this.held.values()) {
      if (workspace.projects.flatMap((project) => project.nodes.filter((node) => node.id === target.node.id)).length !== 1)
        throw new Error('canvas-execution-reserved: node placement became ambiguous')
    }
    for (const projectId of new Set([...this.held.values()].map((target) => target.project.id))) {
      const matches = workspace.projects.filter((project) => project.id === projectId)
      if (matches.length !== 1) throw new Error('canvas-execution-reserved: cannot remove a reserved project')
      this.assertProject(matches[0])
    }
  }
  assertStorageChange(projectId: string): void {
    if ([...this.held.values()].some((target) => target.project.id === projectId))
      throw new Error('canvas-execution-reserved: cannot move reserved project storage')
  }

  /** Only accepted, ordered ops advance the correction snapshot. A rejected optimistic edit or
   * a candidate write must never become the canonical visual state. Exec fields remain private. */
  onReflected(projectId: string, mutation: CanvasMutation, trusted: boolean): void {
    if (mutation.op !== 'upsert') return
    const target = this.held.get(key(projectId, mutation.node.id))
    if (!target) return
    const candidate = carryLocalNodeExec(target.node, mutation.node, trusted)
    if (canvasExecutionBinding(target.project, candidate) === target.binding) target.node = structuredClone(candidate)
  }

  inspectClient(projectId: string, mutation: CanvasMutation, fromOwner: boolean): ClientMutationRejection | null {
    if (!this.held.size || (mutation.op !== 'upsert' && mutation.op !== 'remove')) return null
    const nodeId = mutation.op === 'upsert' ? mutation.node.id : mutation.id
    const target = this.held.get(key(projectId, nodeId))
    if (target) {
      if (mutation.op === 'upsert') {
        const candidate = structuredClone(carryLocalNodeExec(target.node, mutation.node, fromOwner))
        if (canvasExecutionBinding(target.project, candidate) === target.binding) return null
      }
      return { reason: 'This node is completing another host action. Its execution settings were kept.',
        canonical: { op: 'upsert', node: structuredClone(target.node) } }
    }
    if (mutation.op === 'upsert' && mutation.node.parentId && this.held.has(key(projectId, mutation.node.parentId))) {
      const previous = this.source.node(projectId, nodeId)
      return { reason: 'This group is completing another host action. Add or move members after it finishes.',
        canonical: previous ? { op: 'upsert', node: previous } : { op: 'remove', id: nodeId } }
    }
    return null
  }
}
