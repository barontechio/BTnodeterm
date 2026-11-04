import fs from 'node:fs/promises'
import type { Socket } from 'node:net'
import { parseProcNetTcp, type DevPortOwner } from './dev-ports'

export interface LinuxPreviewProof extends DevPortOwner {
  birth: string
  paneBirth: string
  inode: string
  argv: string[]
}
async function bounded(file: string, max = 1024 * 1024): Promise<string> {
  const handle = await fs.open(file, 'r')
  try {
    const bytes = Buffer.alloc(max + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > max) throw new Error('preview proof exceeds limit')
    return bytes.subarray(0, offset).toString('utf8')
  } finally { await handle.close() }
}
async function processStat(pid: number): Promise<{ birth: string; parent: number }> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid process')
  const stat = await bounded(`/proc/${pid}/stat`, 8192)
  const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)
  if (!/^\d+$/.test(fields[19] ?? '') || !/^\d+$/.test(fields[1] ?? '')) throw new Error('invalid process identity')
  return { birth: fields[19], parent: Number(fields[1]) }
}
async function holds(pid: number, inode: string): Promise<boolean> {
  const dir = await fs.opendir(`/proc/${pid}/fd`)
  let count = 0
  try {
    for await (const entry of dir) {
      if (++count > 4096) return false
      try { if (await fs.readlink(`/proc/${pid}/fd/${entry.name}`) === `socket:[${inode}]`) return true } catch { /* closed fd */ }
    }
  } catch { return false }
  return false
}
async function descendant(pid: number, panePid: number): Promise<boolean> {
  const seen = new Set<number>()
  for (let i = 0; i < 128 && pid > 1 && !seen.has(pid); i++) {
    if (pid === panePid) return true
    seen.add(pid); pid = (await processStat(pid)).parent
  }
  return pid === panePid
}
export async function proveLinuxListener(owner: DevPortOwner): Promise<LinuxPreviewProof | null> {
  if (process.platform !== 'linux' || !['127.0.0.1', '0.0.0.0'].includes(owner.address)) return null
  try {
    const before = await processStat(owner.pid)
    const pane = await processStat(owner.panePid)
    const argv = (await bounded(`/proc/${owner.pid}/cmdline`, 64 * 1024)).split('\0').filter(Boolean)
    const listeners = parseProcNetTcp(await bounded('/proc/net/tcp'))
    const matches = [...listeners.entries()].filter(([, row]) => row.port === owner.port && row.address === owner.address)
    // SO_REUSEPORT and ambiguous wildcard/loopback bindings do not prove a destination.
    const portMatches = [...listeners.values()].filter(row => row.port === owner.port && ['127.0.0.1', '0.0.0.0'].includes(row.address))
    if (matches.length !== 1 || portMatches.length !== 1 || !await holds(owner.pid, matches[0][0]) ||
      !await descendant(owner.pid, owner.panePid) || (await processStat(owner.pid)).birth !== before.birth ||
      (await processStat(owner.panePid)).birth !== pane.birth) return null
    return { ...owner, birth: before.birth, paneBirth: pane.birth, inode: matches[0][0], argv }
  } catch { return null }
}
export function sameLinuxProof(a: LinuxPreviewProof, b: LinuxPreviewProof): boolean {
  return a.pid === b.pid && a.panePid === b.panePid && a.nodeId === b.nodeId && a.port === b.port &&
    a.address === b.address && a.birth === b.birth && a.paneBirth === b.paneBirth && a.inode === b.inode &&
    JSON.stringify(a.argv) === JSON.stringify(b.argv)
}
/** A TCP handshake is not authorization to send HTTP/debugger bytes. Resolve the reverse
 * ESTABLISHED tuple and require the actual accepted socket to belong to the approved process. */
export async function proveLinuxConnection(proof: LinuxPreviewProof, socket: Socket): Promise<boolean> {
  if (socket.destroyed || !socket.localPort || socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== proof.port) return false
  const endpoint = (port: number) => `0100007F:${port.toString(16).toUpperCase().padStart(4, '0')}`
  const local = endpoint(proof.port), remote = endpoint(socket.localPort)
  // A listener may accept asynchronously; bound the wait and never send bytes while waiting.
  for (let attempt = 0; attempt < 20 && !socket.destroyed; attempt++) {
    try {
      if ((await processStat(proof.pid)).birth !== proof.birth) return false
      const rows = (await bounded('/proc/net/tcp')).split('\n').map(row => row.trim().split(/\s+/))
      const accepted = rows.filter(row => row[1] === local && row[2] === remote && row[3] === '01' && /^\d+$/.test(row[9]))
      if (accepted.length === 1 && await holds(proof.pid, accepted[0][9])) {
        const current = await proveLinuxListener(proof)
        return !socket.destroyed && !!current && sameLinuxProof(proof, current)
      }
    } catch { return false }
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  return false
}
