// Content writes shared by host-side canvas commands. The caller serializes its domain
// transaction; WorkspaceStore owns disk serialization. Reflected ops precede authority overlays.
import { publishCanvasMutation } from './canvas-sync'
import { contentOf, diffContent, type CanvasContent } from '../shared/canvas-content'
import { stableStringify } from '../shared/canvas-mutations'
import type { CanvasMutation, CanvasNodeState, Project, Workspace } from '../shared/types'
import type { WorkspaceStore } from './workspace-store'

/** One node edit a verb re-applies to a fresh read (`savePatches`). Idempotent. */
export interface NodePatch {
  projectId: string
  nodeId: string
  /** Apply to the fresh node. true = it LANDED: the node was in the state this patch is for (see
   *  each patch for which). A caller that delivers on the strength of a patch asks this, because the
   *  fresh read can find the node deleted, or re-armed, by a teammate since the verb looked. */
  apply(node: CanvasNodeState): boolean
}

/** What `savePatches` did: whether the save landed, and per patch whether it applied to the fresh
 *  read. A patch LANDED only when both are true. */
export interface PatchSave {
  saved: boolean
  applied: boolean[]
}

export interface CanvasContentWriterDeps {
  workspaceStore: Pick<WorkspaceStore, 'load' | 'save'> &
    Partial<Pick<WorkspaceStore, 'saveChanges' | 'updateWorkspace'>>
  isStopped?(): boolean
  publishMutation?(projectId: string, mutation: CanvasMutation): void
  publishProject?(project: Project): void
}

/** A project absent from a baseline: all of its content is new. */
const EMPTY_CONTENT: CanvasContent = { nodes: [], bridges: [], ropes: [] }

/** Every project's content, deep-copied: a verb edits its workspace in place (`node.pendingLaunch =
 *  …`), so a baseline that shared those objects would diff as unchanged. */
function snapshotContent(workspace: Workspace): Map<string, CanvasContent> {
  return new Map(workspace.projects.map((p) => [p.id, structuredClone(contentOf(p))]))
}

export class CanvasContentWriter {
  private baselines = new WeakMap<Workspace, Map<string, CanvasContent>>()
  private workspaceBaselines = new WeakMap<Workspace, Workspace>()
  private readonly stoppedWrite = new Error('canvas-write-stopped')

  constructor(private readonly deps: CanvasContentWriterDeps) {}

  /** THE ONE READ of the store. A read-only view: never edited, never saved. */
  readWorkspace(): Promise<Workspace> {
    return this.deps.workspaceStore.load({ sideline: false })
  }

  /**
   * The load a verb EDITS. A copy of the workspace, so no verb ever edits an object the store
   * or the canvas authority still holds (a governed project's nodes come from the authority's own
   * state), and the content of every project as loaded: `castAndSave` diffs against it.
   */
  async loadForEdit(): Promise<Workspace> {
    const workspace = structuredClone(await this.readWorkspace())
    this.baselines.set(workspace, snapshotContent(workspace))
    this.workspaceBaselines.set(workspace, structuredClone(workspace))
    return workspace
  }

  private publishChanges(before: Workspace, next: Workspace): number {
    if (this.deps.isStopped?.()) throw this.stoppedWrite
    const previous = snapshotContent(before)
    const cast = this.deps.publishMutation ?? publishCanvasMutation
    let count = 0
    for (const p of next.projects) {
      for (const mutation of diffContent(previous.get(p.id) ?? EMPTY_CONTENT, contentOf(p), p.id)) {
        cast(p.id, structuredClone(mutation))
        count++
      }
    }
    return count
  }

  /** Plan and authorize a synchronous edit against the latest state in the store's save queue.
   * No I/O belongs in the callback: permission checks and the edit share one snapshot. */
  async edit<T>(edit: (workspace: Workspace) => T): Promise<{ value: T; saved: boolean }> {
    if (this.deps.isStopped?.()) throw this.stoppedWrite
    if (this.deps.workspaceStore.updateWorkspace) {
      let value!: T
      const result = await this.deps.workspaceStore.updateWorkspace((fresh) => {
        if (this.deps.isStopped?.()) throw this.stoppedWrite
        value = edit(fresh)
        return fresh
      }, (current, next) => { this.publishChanges(current, next) })
      return { value, saved: result.saved }
    }
    const fresh = await this.loadForEdit()
    const value = edit(fresh)
    return { value, saved: await this.castAndSave(fresh, { onlyIfChanged: true }) }
  }

  /**
   * THE ONE SAVE. Diff every project's whole content against what was last loaded or saved, cast
   * every op, THEN save. Nothing is hand-listed per verb, and that is the point: on a project the
   * canvas authority governs, the save is overlaid with the authority's content, which holds only
   * what it heard as ops, so any change a verb made that is not cast here is dropped from disk
   * (docs/hosted-team-relay.md). The reflector hands each op to the authority synchronously, so
   * every one is in its state before the overlay reads it. The ops are cast from a copy, never from
   * the workspace a verb keeps editing, so nobody downstream holds an object that changes later.
   *
   * Refused once canvas control has stopped: the shell detaches the authority from the store right
   * after, and a verb still mid-launch would otherwise write its copy un-overlaid over the
   * authority's final flush. `onlyIfChanged` skips a save that would carry no op. Answers whether it
   * saved.
   */
  async castAndSave(workspace: Workspace, opts: { onlyIfChanged?: boolean } = {}): Promise<boolean> {
    if (this.deps.isStopped?.()) {
      console.warn('[headless-node-factory] canvas control stopped: a pending canvas write was skipped')
      return false
    }
    const workspaceBase = this.workspaceBaselines.get(workspace)
    if (this.deps.workspaceStore.saveChanges && workspaceBase) {
      let count = 0
      try {
        const committed = await this.deps.workspaceStore.saveChanges(workspaceBase, workspace, (current, next) => {
          count = this.publishChanges(current, next)
        })
        for (const p of workspace.projects) {
          const before = workspaceBase.projects.find((x) => x.id === p.id)
          const saved = committed.projects.find((x) => x.id === p.id)
          if (!saved) {
            if (stableStringify(before) === stableStringify(p)) continue
            return false
          }
          const oldNodes = new Map(before?.nodes.map((n) => [n.id, n]))
          const savedIds = new Set(saved.nodes.map((n) => n.id))
          for (const n of p.nodes) {
            const old = oldNodes.get(n.id)
            if (old && stableStringify(old) !== stableStringify(n) && !savedIds.has(n.id)) return false
          }
        }
      } catch (error) {
        if (error === this.stoppedWrite) return false
        throw error
      }
      this.workspaceBaselines.set(workspace, structuredClone(workspace))
      this.baselines.set(workspace, snapshotContent(workspace))
      return opts.onlyIfChanged ? count > 0 : true
    }
    const before = this.baselines.get(workspace)
    const after = snapshotContent(workspace)
    const cast = this.deps.publishMutation ?? ((projectId: string, m: CanvasMutation) => {
      publishCanvasMutation(projectId, m)
    })
    const ops: Array<[string, CanvasMutation]> = []
    for (const project of workspace.projects) {
      const next = after.get(project.id)
      if (!next) continue
      for (const m of diffContent(before?.get(project.id) ?? EMPTY_CONTENT, next, project.id)) ops.push([project.id, m])
    }
    if (opts.onlyIfChanged && !ops.length) return false
    for (const [projectId, m] of ops) cast(projectId, m)
    this.baselines.set(workspace, after)
    await this.deps.workspaceStore.save(workspace)
    return true
  }

  /**
   * A SECOND phase's save: the launch between the two phases can take seconds, and the copy the
   * verb loaded before it predates whatever a teammate did meanwhile (a move, a rename, a deletion).
   * So re-read, re-apply ONLY this verb's own patches to the nodes that still exist (a node deleted
   * meanwhile stays deleted), and save only if that changed anything. The patches must be idempotent:
   * every call re-applies all of them, so a later save still carries an earlier one.
   *
   * Answers per patch whether it applied to the fresh read, and whether the save landed: a caller
   * that delivers on the strength of a claim must see BOTH (a stopping factory refuses the save, and
   * the node may be gone or re-armed since the verb looked).
   */
  async savePatches(patches: readonly NodePatch[]): Promise<PatchSave> {
    if (!patches.length) return { saved: false, applied: [] }
    if (this.deps.isStopped?.()) {
      console.warn('[headless-node-factory] canvas control stopped: a pending canvas write was skipped')
      return { saved: false, applied: patches.map(() => false) }
    }
    if (this.deps.workspaceStore.updateWorkspace) {
      let applied = patches.map(() => false)
      try {
        const result = await this.deps.workspaceStore.updateWorkspace((fresh) => {
          if (this.deps.isStopped?.()) throw this.stoppedWrite
          applied = patches.map((patch) => {
            const node = fresh.projects.find((p) => p.id === patch.projectId)?.nodes.find((n) => n.id === patch.nodeId)
            return node ? patch.apply(node) : false
          })
          return fresh
        }, (current, next) => { this.publishChanges(current, next) })
        return { saved: result.saved, applied }
      } catch (error) {
        if (error === this.stoppedWrite) {
          console.warn('[headless-node-factory] canvas control stopped: a pending canvas write was skipped')
          return { saved: false, applied: patches.map(() => false) }
        }
        throw error
      }
    }
    const workspace = await this.loadForEdit()
    const applied = patches.map((patch) => {
      const node = workspace.projects.find((p) => p.id === patch.projectId)?.nodes.find((n) => n.id === patch.nodeId)
      return node ? patch.apply(node) : false
    })
    return { saved: await this.castAndSave(workspace, { onlyIfChanged: true }), applied }
  }

  /** The PERSISTED projects to browsers (`workspace:server-change`), re-read after the save — never
   *  a verb's own copy, which can predate a teammate's edit and would undo it on every client that
   *  merges it. Their content already travelled as ops in `castAndSave`. */
  async publishPersisted(projectIds: Iterable<string>): Promise<void> {
    if (!this.deps.publishProject || this.deps.isStopped?.()) return
    const wanted = new Set(projectIds)
    if (!wanted.size) return
    for (const project of (await this.readWorkspace()).projects) {
      if (wanted.has(project.id)) this.deps.publishProject(project)
    }
  }

}
