import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { makeRemoteWorkspaceIO } from './remote-workspace-io'
import type { SshFs, SshFsRef } from './ssh-fs'
import type { Project } from '../shared/types'

const ssh = { server: { host: 'h', user: 'u' }, remoteCwd: '~/app' } as NonNullable<Project['ssh']>
const ref: SshFsRef = { conn: { host: 'h', user: 'u' }, controlPath: '/s.sock' }

/** Minimal fake of the two SshFs members the workspace IO uses. */
const fakeFs = () => {
  const fs = {
    readTextChecked: vi.fn(async () => ({ status: 'ok' as const, content: 'body' })),
    writeText: vi.fn(async (_ref: SshFsRef, _path: string, _content: string) => true)
  }
  return { fs, sshFs: fs as unknown as SshFs }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('read', () => {
  it('disconnected (no ref) → error, never absent: a down connection must not read as "no file"', async () => {
    const { sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => null, sshFs)
    expect(await io.read('p1', ssh)).toEqual({ status: 'error' })
  })

  it('passes the checked read result through (ok / absent / error)', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    expect(await io.read('p1', ssh)).toEqual({ status: 'ok', content: 'body' })
    fs.readTextChecked.mockResolvedValueOnce({ status: 'absent' } as never)
    expect(await io.read('p1', ssh)).toEqual({ status: 'absent' })
    fs.readTextChecked.mockResolvedValueOnce({ status: 'error' } as never)
    expect(await io.read('p1', ssh)).toEqual({ status: 'error' })
  })
})

describe('write', () => {
  it('an immediate write reports the REAL outcome (false when the remote write fails)', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    fs.writeText.mockResolvedValueOnce(false as never)
    expect(await io.write('p1', ssh, 'c1')).toBe(false)
    expect(await io.write('p1', ssh, 'c2')).toBe(true)
  })

  it('a throttled trailing write that fails reports the drop via onDropped (so the store re-owes it)', async () => {
    const { fs, sshFs } = fakeFs()
    const dropped: string[] = []
    const io = makeRemoteWorkspaceIO(() => ref, sshFs, (id) => dropped.push(id))
    expect(await io.write('p1', ssh, 'c1')).toBe(true) // immediate
    fs.writeText.mockResolvedValue(false as never) // connection flaps inside the throttle window
    expect(await io.write('p1', ssh, 'c2')).toBe(true) // scheduled (optimistic ack)
    await vi.advanceTimersByTimeAsync(5000)
    expect(dropped).toEqual(['p1'])
  })

  it('a trailing write that THROWS also reports the drop (never an unhandled rejection)', async () => {
    const { fs, sshFs } = fakeFs()
    const dropped: string[] = []
    const io = makeRemoteWorkspaceIO(() => ref, sshFs, (id) => dropped.push(id))
    await io.write('p1', ssh, 'c1')
    fs.writeText.mockRejectedValue(new Error('conn reset'))
    await io.write('p1', ssh, 'c2')
    await vi.advanceTimersByTimeAsync(5000)
    expect(dropped).toEqual(['p1'])
  })

  it('newer content still replaces a pending trailing write (final-state-wins)', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    await io.write('p1', ssh, 'c1') // immediate
    await io.write('p1', ssh, 'c2') // scheduled
    await io.write('p1', ssh, 'c3') // reschedules, replacing c2
    await vi.advanceTimersByTimeAsync(5000)
    const bodies = fs.writeText.mock.calls.map((c) => c[2])
    expect(bodies).toEqual(['c1', 'c3'])
  })
})

/** The read fake above is declared param-less, so its recorded arguments need a cast to be read. */
const readPaths = (fs: ReturnType<typeof fakeFs>['fs']): string[] =>
  (fs.readTextChecked.mock.calls as unknown as [SshFsRef, string][]).map((c) => c[1])

describe('settings IO', () => {
  it('targets <remoteCwd>/.nodeterm/settings.json, not project.json', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    await io.readSettings!('p1', ssh)
    await io.writeSettings!('p1', ssh, 'body')
    // project.json's own path is unchanged by the refactor.
    await io.read('p1', ssh)
    expect(readPaths(fs)).toEqual(['~/app/.nodeterm/settings.json', '~/app/.nodeterm/project.json'])
    expect(fs.writeText.mock.calls[0][1]).toBe('~/app/.nodeterm/settings.json')
  })

  it('is NOT throttled: settings are cold, so two writes in a row both hit the wire', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    expect(await io.writeSettings!('p1', ssh, 'c1')).toBe(true)
    expect(await io.writeSettings!('p1', ssh, 'c2')).toBe(true)
    expect(fs.writeText.mock.calls.map((c) => c[2])).toEqual(['c1', 'c2'])
  })

  it('disconnected → read errors (never absent) and the write is a quiet no-op', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => null, sshFs)
    expect(await io.readSettings!('p1', ssh)).toEqual({ status: 'error' })
    expect(await io.writeSettings!('p1', ssh, 'c1')).toBe(false)
    expect(fs.writeText).not.toHaveBeenCalled()
  })

  it('a throwing settings write reports false instead of rejecting', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    fs.writeText.mockRejectedValueOnce(new Error('conn reset'))
    expect(await io.writeSettings!('p1', ssh, 'c1')).toBe(false)
  })

  it('a settings write does not disturb project.json throttling', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    await io.write('p1', ssh, 'p1-immediate')
    await io.writeSettings!('p1', ssh, 'settings')
    await io.write('p1', ssh, 'p1-trailing') // still inside the 5s window
    expect(fs.writeText.mock.calls.map((c) => c[2])).toEqual(['p1-immediate', 'settings'])
    await vi.advanceTimersByTimeAsync(5000)
    expect(fs.writeText.mock.calls.map((c) => c[2])).toEqual(['p1-immediate', 'settings', 'p1-trailing'])
  })
})

describe('flush', () => {
  it('fires every pending trailing write immediately (quit path: masters die right after)', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    await io.write('p1', ssh, 'c1') // immediate
    await io.write('p1', ssh, 'c2') // pending trailing
    await io.flush()
    const bodies = fs.writeText.mock.calls.map((c) => c[2])
    expect(bodies).toEqual(['c1', 'c2']) // no 5s wait
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fs.writeText).toHaveBeenCalledTimes(2) // and the timer did not double-fire
  })

  it('flush with nothing pending resolves without writing', async () => {
    const { fs, sshFs } = fakeFs()
    const io = makeRemoteWorkspaceIO(() => ref, sshFs)
    await io.flush()
    expect(fs.writeText).not.toHaveBeenCalled()
  })
})


describe('destination replacement', () => {
  it('never writes a queued old snapshot to the replacement host or directory', async () => {
    for (const replacement of [
      { ...ref, conn: { ...ref.conn, host: 'other' } },
      { ...ref, conn: { ...ref.conn, port: 2222 } },
      { ...ref, remoteCwd: '/other' }
    ]) {
      const { fs, sshFs } = fakeFs(); const dropped: string[] = []
      let current: typeof ref & { remoteCwd?: string } = ref
      const io = makeRemoteWorkspaceIO(() => current, sshFs, (id) => dropped.push(id))
      expect(await io.write('p1', ssh, 'first')).toBe(true)
      expect(await io.write('p1', ssh, 'stale')).toBe(true)
      current = replacement
      await io.flush()
      expect(fs.writeText).toHaveBeenCalledTimes(1)
      expect(dropped).toEqual(['p1'])
      expect(await io.read('p1', ssh)).toEqual({ status: 'error' })
      expect(await io.writeSettings!('p1', ssh, '{}')).toBe(false)
      expect(fs.readTextChecked).not.toHaveBeenCalled()
    }
  })
})
