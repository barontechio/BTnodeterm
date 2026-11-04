import { randomBytes } from 'node:crypto'
import type { Socket } from 'node:net'
import { collectLocalDevPorts, type DevPortOwner } from './dev-ports'
import { proveLinuxListener, proveLinuxConnection, sameLinuxProof, type LinuxPreviewProof } from './development-preview-linux'
import type { DevelopmentPreviewAuthority, DevelopmentTarget } from './development-previews'
import type { DevelopmentPreviewScope, DevelopmentPreviewRecord } from '../shared/development-preview'

/** Operator-owned configuration. Never accepted as RPC parameters. argv is the exact NUL-split
 * process command line, not a regex/substring identifying any program named node. */
export interface ApprovedDevelopmentService extends DevelopmentPreviewScope { port: number; argv: string[] }
interface RecordEntry { owner: string; config: ApprovedDevelopmentService; proof: LinuxPreviewProof; execution: object; target: DevelopmentTarget; expires: number }
export interface LocalDevelopmentAuthorityOptions {
  approved: readonly ApprovedDevelopmentService[]
  tmuxBin(): string | null
  ownerCurrent(owner: string): boolean
  /** Must check unique persisted project/node membership, local routing and actual live session. */
  execution(scope: DevelopmentPreviewScope): Promise<object | undefined>
  current(scope: DevelopmentPreviewScope, execution: object): boolean
  managementPorts(): number[]
  /** Tests may select their sandbox tmux socket through the existing collector exec seam. */
  collect?: typeof collectLocalDevPorts
}
const debugCommand = /(?:--inspect|--remote-debugging|nodeterm|node-terminal|chrome|chromium|devtools|jupyter|code-server)/i
export function parseApprovedDevelopmentServices(raw: string): ApprovedDevelopmentService[] {
  const rows: unknown = JSON.parse(raw)
  if (!Array.isArray(rows) || rows.length > 32) throw new Error('Development preview targets must be an array of at most 32 approved services')
  return rows.map(row => {
    if (!row || typeof row !== 'object') throw new Error('Invalid development target')
    const { projectId, nodeId, port, argv } = row
    if (typeof projectId !== 'string' || !projectId || projectId.length > 256 || typeof nodeId !== 'string' || !nodeId || nodeId.length > 256 ||
      !Number.isInteger(port) || port < 1024 || port >= 32768 || [2375, 2376, 9222, 9229].includes(port) ||
      !Array.isArray(argv) || !argv.length || argv.length > 64 || argv.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0') || debugCommand.test(arg))) throw new Error('Development target is invalid, privileged, ephemeral or a management/debug command')
    return { projectId, nodeId, port, argv: [...argv] }
  })
}
export class LocalDevelopmentAuthority implements DevelopmentPreviewAuthority {
  private records = new Map<string, RecordEntry>()
  private listing = new Map<string, { cancelled: boolean }>()
  private stopped = false
  constructor(private options: LocalDevelopmentAuthorityOptions) {
    this.options = { ...options, approved: parseApprovedDevelopmentServices(JSON.stringify(options.approved)) }
  }
  private allowed(config: ApprovedDevelopmentService): boolean {
    return !this.options.managementPorts().includes(config.port)
  }
  async list(owner: string, scope: DevelopmentPreviewScope): Promise<DevelopmentPreviewRecord[]> {
    if (this.stopped || process.platform !== 'linux' || !this.options.ownerCurrent(owner) || this.listing.size >= 4 || this.listing.has(owner)) throw new Error('Development preview unavailable or busy')
    const ticket = { cancelled: false }
    this.listing.set(owner, ticket)
    try {
      for (const [id, entry] of this.records) if (entry.expires <= Date.now()) this.records.delete(id)
      const execution = await this.options.execution(scope)
      if (!execution) return []
      const eligible = this.options.approved.filter(c => c.projectId === scope.projectId && c.nodeId === scope.nodeId && this.allowed(c))
      if (!eligible.length) return []
      const owners: DevPortOwner[] = []
      const report = await (this.options.collect ?? collectLocalDevPorts)({ tmuxBin: this.options.tmuxBin, observe: owner => { if (owner.nodeId === scope.nodeId && eligible.some(c => c.port === owner.port)) owners.push(owner) } })
      if (!report.ok) throw new Error('Development listener discovery unavailable')
      const out: DevelopmentPreviewRecord[] = []
      for (const config of eligible) {
        const candidates = owners.filter(o => o.port === config.port && ['127.0.0.1', '0.0.0.0'].includes(o.address))
        if (candidates.length !== 1) continue
        const proof = await proveLinuxListener(candidates[0])
        if (!proof || JSON.stringify(proof.argv) !== JSON.stringify(config.argv)) continue
        if (this.stopped || !this.options.ownerCurrent(owner) || await this.options.execution(scope) !== execution) throw new Error('Development preview scope changed')
        // PID reuse after the discovery is refused by a second ownership observation.
        const confirmed: DevPortOwner[] = []
        const check = await (this.options.collect ?? collectLocalDevPorts)({ tmuxBin: this.options.tmuxBin, observe: o => confirmed.push(o) })
        const fresh = await proveLinuxListener(proof)
        if (!check.ok || !fresh || !sameLinuxProof(proof, fresh) || !confirmed.some(o => o.nodeId === scope.nodeId && o.pid === proof.pid && o.panePid === proof.panePid && o.port === proof.port && o.address === proof.address)) continue
        if (this.stopped || !this.options.ownerCurrent(owner) || await this.options.execution(scope) !== execution) throw new Error('Development preview scope changed')
        if (this.stopped || !this.options.ownerCurrent(owner) || this.listing.get(owner) !== ticket || ticket.cancelled) throw new Error('Development preview owner departed')
        const existing = [...this.records.entries()].find(([, r]) => r.owner === owner && r.config.projectId === scope.projectId && r.execution === execution && sameLinuxProof(r.proof, proof))
        if (existing) { out.push({ id: existing[0], label: `Port ${config.port}` }); continue }
        if (this.records.size >= 64) throw new Error('Development preview record limit reached')
        const id = randomBytes(24).toString('hex')
        if (this.records.has(id)) throw new Error('Development preview record collision')
        const target: DevelopmentTarget = { ...scope, generation: randomBytes(16).toString('hex'), processIdentity: `${proof.pid}:${proof.birth}:${proof.inode}:${proof.panePid}:${proof.paneBirth}`, hostIdentity: 'local-linux', address: '127.0.0.1', port: config.port }
        this.records.set(id, { owner, config, proof, execution, target, expires: Date.now() + 5 * 60_000 })
        out.push({ id, label: `Port ${config.port}` })
      }
      return out
    } finally { if (this.listing.get(owner) === ticket) this.listing.delete(owner) }
  }
  async resolve(owner: string, recordId: string): Promise<DevelopmentTarget | null> {
    const record = this.records.get(recordId)
    if (!record || this.stopped || record.owner !== owner || record.expires <= Date.now() || !this.options.ownerCurrent(owner) || !this.allowed(record.config)) return null
    if (await this.options.execution(record.config) !== record.execution) return null
    const proof = await proveLinuxListener(record.proof)
    if (!proof || !sameLinuxProof(record.proof, proof) || this.stopped || !this.options.ownerCurrent(owner) || this.records.get(recordId) !== record || await this.options.execution(record.config) !== record.execution) return null
    if (this.stopped || !this.options.ownerCurrent(owner) || this.records.get(recordId) !== record || record.expires <= Date.now()) return null
    return { ...record.target }
  }
  current(owner: string, recordId: string): boolean {
    const record = this.records.get(recordId)
    return !!record && !this.stopped && record.owner === owner && record.expires > Date.now() &&
      this.options.ownerCurrent(owner) && this.allowed(record.config) && this.options.current(record.config, record.execution)
  }
  async connected(owner: string, recordId: string, socket: Socket): Promise<boolean> {
    const record = this.records.get(recordId)
    return !!record && !!await this.resolve(owner, recordId) && await proveLinuxConnection(record.proof, socket) && !!await this.resolve(owner, recordId)
  }
  forgetOwner(owner: string): void { const pending = this.listing.get(owner); if (pending) pending.cancelled = true; for (const [id, entry] of this.records) if (entry.owner === owner) this.records.delete(id) }
  stop(): void { this.stopped = true; this.records.clear() }
}
