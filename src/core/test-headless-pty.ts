// Test-only echoing shell for host-side launch behavior.
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'
import type { HeadlessPty } from './headless-node-factory'
import { NodeExecutionCoordinator, type NodeExecutionKind, type NodeExecutionOptions, type NodeExecutionPermit } from './node-execution'

export class FakeHeadlessPty implements HeadlessPty {
  private readonly execution = new NodeExecutionCoordinator()
  private readonly generations = new Map<string, object>()
  nodeExecutionIdentity(id: string): object | undefined { return this.live.has(id) ? this.generations.get(id) : undefined }
  runNodeAction<T>(id: string, kind: NodeExecutionKind, options: NodeExecutionOptions,
    work: (permit: NodeExecutionPermit) => Promise<T> | T): Promise<T> { return this.execution.run(id, kind, options, work) }
  beforeCreate?: (options: PtyCreateOptions) => Promise<void>
  readonly creates: PtyCreateOptions[] = []
  readonly sends: Array<{ nodeId: string; text: string }> = []
  readonly destroys: Array<{
    clientId: number | null
    nodeId: string
    everySocket: boolean | undefined
    wasLive: boolean
  }> = []
  readonly live = new Set<string>()
  readonly alreadyDead = new Set<string>()
  readonly released: string[] = []
  private readonly taps = new Map<string, Set<(c: string) => void>>()
  private readonly lines = new Map<string, string>()

  persistentSpawnAvailable(): boolean {
    return true
  }

  onOutput(key: string, cb: (c: string) => void): () => void {
    let set = this.taps.get(key)
    if (!set) this.taps.set(key, (set = new Set()))
    set.add(cb)
    return () => set!.delete(cb)
  }

  // An interactive shell: echoes what it is typed; Enter submits the line (recorded in `sends`,
  // so every pre-existing `pty.sends` assertion keeps its meaning); Ctrl-U / Esc clear it.
  writeHeadless(key: string, data: string): boolean {
    try { this.execution.assertAllowed(key) } catch { return false }
    if (!this.live.has(key)) return false
    if (data === '\r') {
      this.sends.push({ nodeId: key, text: this.lines.get(key) ?? '' })
      this.lines.set(key, '')
      return true
    }
    if (data === '\x15' || data === '\x1b') {
      this.lines.set(key, '')
      return true
    }
    this.lines.set(key, (this.lines.get(key) ?? '') + data)
    for (const cb of [...(this.taps.get(key) ?? [])]) cb(data)
    return true
  }

  releaseHeadless(key: string): void {
    this.released.push(key)
  }

  async createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    this.execution.assertAllowed(options.persistKey ?? '')
    await this.beforeCreate?.(options)
    this.execution.assertAllowed(options.persistKey ?? '')
    this.creates.push(options)
    if (options.persistKey) { this.live.add(options.persistKey); this.generations.set(options.persistKey, {}) }
    return { sessionId: `pty-${options.persistKey}`, fresh: true, persistent: true }
  }

  async paneCommand(): Promise<string | null> { return 'bash' }

  async sessionExists(persistKey: string): Promise<boolean> {
    return this.live.has(persistKey)
  }

  async sendText(nodeId: string, text: string): Promise<boolean> {
    this.sends.push({ nodeId, text })
    return true
  }

  async destroySession(
    clientId: number | null,
    nodeId: string,
    opts?: { everySocket?: boolean }
  ): Promise<void> {
    const wasLive = this.live.delete(nodeId)
    this.destroys.push({ clientId, nodeId, everySocket: opts?.everySocket, wasLive })
    this.alreadyDead.add(nodeId)
  }

  killOutOfBand(nodeId: string): void {
    this.live.delete(nodeId)
    this.alreadyDead.add(nodeId)
  }
}

