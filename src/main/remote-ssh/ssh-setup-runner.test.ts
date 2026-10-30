import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../../shared/ssh'

const spawnMock = vi.hoisted(() => vi.fn())
// Partial: `spawn` is the seam under test, but the same module object backs every OTHER
// `child_process` import in the graph (exec-path's `execFile`), and a bare stub breaks those.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: spawnMock }
})

import { makeSshSetupRunner, type SshSetupEndpoint, type SshSetupRef } from './ssh-setup-runner'
import { SshProjectManager } from './ssh-project'
import { controlPathFor } from '../../core/remote-ssh/control-master'

/** The child `spawn` returns: an EventEmitter with `stdout`/`stderr` emitters and a spy `kill`. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter()
  stderr = new EventEmitter()
  pid = 4242
  kill = vi.fn(() => true)
}

const conn: SshConnection = { host: 'example.test', user: 'deploy' }
const ssh = { server: { host: 'example.test', user: 'deploy' }, remoteCwd: '/srv/app' }
const ref: SshSetupRef = { conn, controlPath: '/tmp/nt-ctl/example.test-deploy.sock' }

/**
 * Everything in `cmd` that is NOT inside a single-quoted region. The injection assertion the brief
 * asks for: a hostile script may contain `$(rm -rf /)`, but every byte of it must land INSIDE a
 * quoted argument, so the unquoted residue is only the shell syntax WE wrote.
 */
function unquotedPart(cmd: string): string {
  let out = ''
  let inQuotes = false
  let i = 0
  while (i < cmd.length) {
    const ch = cmd[i]
    if (inQuotes) {
      if (ch === "'") inQuotes = false
      i += 1
      continue
    }
    if (ch === "'") {
      inQuotes = true
      i += 1
      continue
    }
    // Outside quotes a backslash escapes the next byte — `'\''` (posixQuote's escape for an
    // embedded quote) must not be mistaken for "quote closed, then quote reopened".
    if (ch === '\\') {
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  expect(inQuotes).toBe(false) // an unbalanced quote would itself be an injection hole
  return out
}

describe('makeSshSetupRunner', () => {
  let child: FakeChild

  beforeEach(() => {
    spawnMock.mockReset()
    child = new FakeChild()
    spawnMock.mockReturnValue(child)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const run = (
    opts: {
      script?: string
      cwd?: string
      env?: Record<string, string>
      resolveRef?: (endpoint: SshSetupEndpoint) => SshSetupRef | null
      timeoutMs?: number
      ssh?: { server: { host: string; user: string; port?: number; identityFile?: string }; remoteCwd: string } | undefined
      signal?: AbortSignal
    } = {}
  ) => {
    const runner = makeSshSetupRunner(opts.resolveRef ?? (() => ref), {
      timeoutMs: opts.timeoutMs,
      sshPath: () => '/usr/bin/ssh',
      agentEnv: () => ({ SSH_AUTH_SOCK: '/tmp/nt-agent.sock' })
    })
    const chunks: string[] = []
    const controller = new AbortController()
    const promise = runner({
      script: opts.script ?? 'npm install',
      cwd: opts.cwd ?? '/srv/app',
      env: opts.env ?? {},
      onChunk: (t) => chunks.push(t),
      signal: opts.signal ?? controller.signal,
      ssh: 'ssh' in opts ? opts.ssh : ssh
    })
    return { promise, chunks, controller }
  }

  const argv = (): string[] => spawnMock.mock.calls[0][1] as string[]
  const remoteCommand = (): string => argv()[argv().length - 1]

  it('spawns ONE ssh child whose argv carries the ControlPath', async () => {
    const { promise } = run()
    child.emit('close', 0)
    await promise
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][0]).toBe('/usr/bin/ssh')
    expect(argv()).toContain(`ControlPath=${ref.controlPath}`)
    expect(argv()).toContain('ControlMaster=auto')
    expect(argv()).toContain('deploy@example.test')
  })

  it('hands the resolver the FULL endpoint, not just the remote cwd', async () => {
    const seen: SshSetupEndpoint[] = []
    const { promise } = run({
      ssh: { server: { host: 'example.test', user: 'deploy', port: 2222 }, remoteCwd: '/srv/app' },
      resolveRef: (e) => {
        seen.push(e)
        return { conn: { host: 'example.test', user: 'deploy', port: 2222 }, controlPath: '/tmp/c.sock' }
      }
    })
    child.emit('close', 0)
    await promise
    expect(seen).toEqual([{ host: 'example.test', user: 'deploy', port: 2222, remoteCwd: '/srv/app' }])
  })

  it('refuses a resolved connection on the WRONG PORT (same user@host is not the same machine)', async () => {
    const { promise, chunks } = run({
      ssh: { server: { host: 'example.test', user: 'deploy', port: 2222 }, remoteCwd: '/srv/app' },
      resolveRef: () => ({ conn: { host: 'example.test', user: 'deploy', port: 2022 }, controlPath: '/tmp/c.sock' })
    })
    const result = await promise
    expect(result.exitCode).toBe(255)
    expect(chunks.join('')).toContain('deploy@example.test:2022')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('treats an absent port and an explicit 22 as the same endpoint', async () => {
    const { promise } = run({
      ssh: { server: { host: 'example.test', user: 'deploy', port: 22 }, remoteCwd: '/srv/app' },
      resolveRef: () => ref // conn has no `port` at all
    })
    child.emit('close', 0)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a different identity file even at the same host, user and port', async () => {
    const { promise } = run({
      ssh: { server: { host: 'example.test', user: 'deploy', identityFile: '/wanted-key' }, remoteCwd: '/srv/app' },
      resolveRef: (endpoint) => {
        expect(endpoint.identityFile).toBe('/wanted-key')
        return { conn: { host: 'example.test', user: 'deploy', identityFile: '/other-key' }, controlPath: '/tmp/c.sock' }
      }
    })
    expect((await promise).exitCode).toBe(255)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('the remote command cds into the quoted remote cwd and runs the script through sh -lc', async () => {
    const { promise } = run({ script: 'make build', cwd: '/srv/app' })
    child.emit('close', 0)
    await promise
    expect(remoteCommand()).toContain(`cd '/srv/app' &&`)
    expect(remoteCommand()).toContain(`sh -lc 'make build'`)
  })

  // The whole reason the `cd` uses quoteRemotePath instead of posixQuote: single quotes suppress
  // tilde expansion, and `~` is the DEFAULT remoteCwd — `cd '~/app'` would look for a directory
  // literally named `~`. Swapping back to posixQuote must fail this pair.
  it('leaves a leading ~ bare so the remote shell expands it, quoting the rest of the path', async () => {
    const { promise } = run({ cwd: '~/app' })
    child.emit('close', 0)
    await promise
    expect(remoteCommand()).toContain(`cd ~/'app' &&`)
    expect(remoteCommand()).not.toContain(`cd '~/app'`)
  })

  it('a bare ~ is the whole carve-out: a ~-prefixed hostile path is still fully quoted', async () => {
    const { promise } = run({ cwd: '~$(touch /tmp/pwned)' })
    child.emit('close', 0)
    await promise
    const cmd = remoteCommand()
    expect(cmd).toContain(`cd '~$(touch /tmp/pwned)' &&`)
    expect(unquotedPart(cmd)).not.toContain('$(')
  })

  it('inlines the env as quoted assignments (ssh forwards no local env)', async () => {
    const { promise } = run({
      env: {
        NODETERM_ROOT_PATH: '/srv/app',
        NODETERM_WORKTREE_PATH: '/srv/app',
        NODETERM_PROJECT_NAME: "my app's repo"
      }
    })
    child.emit('close', 0)
    await promise
    const cmd = remoteCommand()
    expect(cmd).toContain(`NODETERM_ROOT_PATH='/srv/app'`)
    expect(cmd).toContain(`NODETERM_WORKTREE_PATH='/srv/app'`)
    expect(cmd).toContain(`NODETERM_PROJECT_NAME='my app'\\''s repo'`)
    // Assignments must precede `sh`, or they are arguments rather than environment.
    expect(cmd.indexOf('NODETERM_ROOT_PATH=')).toBeLessThan(cmd.indexOf('sh -lc'))
  })

  it('omits an env entry whose NAME cannot be a shell identifier rather than splicing it', async () => {
    const { promise } = run({ env: { 'BAD;NAME': 'x', GOOD: 'y' } })
    child.emit('close', 0)
    await promise
    expect(remoteCommand()).not.toContain('BAD')
    expect(remoteCommand()).toContain(`GOOD='y'`)
  })

  it('a hostile script and a hostile project name land ONLY inside quoted arguments', async () => {
    const { promise } = run({
      script: `'$(rm -rf /)'; echo pwned \`id\``,
      cwd: "/srv/'; rm -rf /; '",
      env: { NODETERM_PROJECT_NAME: `x'$(id)'y` }
    })
    child.emit('close', 0)
    await promise
    const residue = unquotedPart(remoteCommand())
    expect(residue).not.toContain('$(')
    expect(residue).not.toContain('`')
    expect(residue).not.toContain('rm -rf')
    expect(residue).not.toContain('pwned')
    expect(residue).not.toContain('id')
    // What SHOULD remain unquoted is only our own syntax.
    expect(residue.replace(/\s+/g, ' ').trim()).toContain('cd && ')
  })

  it('streams stderr as chunks too', async () => {
    const { promise, chunks } = run()
    child.stderr.emit('data', Buffer.from('warning: node_modules is stale\n'))
    child.stdout.emit('data', Buffer.from('ok\n'))
    child.emit('close', 0)
    const result = await promise
    expect(result.exitCode).toBe(0)
    expect(chunks.join('')).toContain('warning: node_modules is stale')
    expect(chunks.join('')).toContain('ok')
  })

  it('coalesces rapid writes into fewer chunks than writes (debounced)', async () => {
    const { promise, chunks } = run()
    for (let i = 0; i < 5; i++) child.stdout.emit('data', Buffer.from(`line ${i}\n`))
    child.emit('close', 0)
    await promise
    expect(chunks.length).toBeLessThan(5)
    expect(chunks.join('')).toContain('line 4')
  })

  it('propagates the remote exit code', async () => {
    const { promise } = run()
    child.emit('close', 7)
    const result = await promise
    expect(result.exitCode).toBe(7)
  })

  it('an abort kills the ssh client (and never spawns a second one)', async () => {
    const controller = new AbortController()
    const { promise } = run({ signal: controller.signal, timeoutMs: 60_000 })
    controller.abort()
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('close', null)
    const result = await promise
    expect(result.exitCode).not.toBe(0)
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('says out loud that a cancel does NOT stop the remote command', async () => {
    const controller = new AbortController()
    const { promise, chunks } = run({ signal: controller.signal, timeoutMs: 60_000 })
    controller.abort()
    child.emit('close', null)
    await promise
    const combined = chunks.join('')
    expect(combined).toContain('cancelled')
    expect(combined).toContain('may still be running')
  })

  it('says the same about a timeout kill', async () => {
    const { promise, chunks } = run({ timeoutMs: 10 })
    await new Promise((r) => setTimeout(r, 40))
    child.emit('close', null)
    await promise
    expect(chunks.join('')).toContain('timed out')
    expect(chunks.join('')).toContain('may still be running')
  })

  it('refuses to start when already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const { promise } = run({ signal: controller.signal })
    const result = await promise
    expect(result.exitCode).toBe(143)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('SIGKILLs a run that outlives the timeout', async () => {
    const { promise } = run({ timeoutMs: 10 })
    await new Promise((r) => setTimeout(r, 40))
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    child.emit('close', null)
    await promise
  })

  it('never rejects: a spawn error resolves 255 with the message as a chunk', async () => {
    const { promise, chunks } = run()
    child.emit('error', new Error('spawn /usr/bin/ssh ENOENT'))
    const result = await promise
    expect(result.exitCode).toBe(255)
    expect(chunks.join('')).toContain('ENOENT')
  })

  it('a disconnected project (no ref) fails with 255 and an explanation — no spawn, no retry', async () => {
    const { promise, chunks } = run({ resolveRef: () => null })
    const result = await promise
    expect(result.exitCode).toBe(255)
    expect(chunks.join('').length).toBeGreaterThan(0)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses when the resolved connection is a DIFFERENT host than the target names', async () => {
    const otherHost: SshSetupRef = { conn: { host: 'evil.test', user: 'deploy' }, controlPath: '/tmp/x.sock' }
    const { promise, chunks } = run({ resolveRef: () => otherHost })
    const result = await promise
    expect(result.exitCode).toBe(255)
    expect(chunks.join('')).toContain('evil.test')
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('refuses a run with no ssh target at all', async () => {
    const { promise } = run({ ssh: undefined })
    const result = await promise
    expect(result.exitCode).toBe(255)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('never rejects when the ref resolver itself throws', async () => {
    const { promise, chunks } = run({
      resolveRef: () => {
        throw new Error('manager exploded')
      }
    })
    const result = await promise
    expect(result.exitCode).toBe(255)
    expect(chunks.join('')).toContain('manager exploded')
  })

  it('never rejects when spawn throws synchronously', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('Invalid argument')
    })
    const { promise, chunks } = run()
    const result = await promise
    expect(result.exitCode).toBe(255)
    expect(chunks.join('')).toContain('Invalid argument')
  })

  it('a dead master (ssh exits 255) surfaces ssh stderr and does not respawn', async () => {
    const { promise, chunks } = run()
    child.stderr.emit('data', Buffer.from('ssh: connect to host example.test port 22: Connection refused\n'))
    child.emit('close', 255)
    const result = await promise
    expect(result.exitCode).toBe(255)
    expect(chunks.join('')).toContain('Connection refused')
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  /**
   * The resolver seam against the REAL manager, wired exactly as `src/main/index.ts` wires it. A
   * fake resolver could not catch the two collisions that made cwd-only resolution wrong, because
   * the collision lives in the LOOKUP, not in the runner.
   */
  describe('resolved through SshProjectManager.refForEndpoint (as main wires it)', () => {
    const makeMgr = (): SshProjectManager =>
      new SshProjectManager({
        userDataDir: '/ud',
        spawnMaster: vi.fn(() => ({ kill: vi.fn(), on: vi.fn() })),
        run: vi.fn(async () => ({ code: 0, stdout: '' })),
        runScp: vi.fn(async () => ({ code: 0 })),
        getHook: () => ({ port: 51234, token: 'tok', version: '1' }),
        onStatus: () => {}
      })

    const runVia = (mgr: SshProjectManager, target: { server: { host: string; user: string; port?: number; identityFile?: string }; remoteCwd: string }) => {
      const runner = makeSshSetupRunner((endpoint) => mgr.refForEndpoint(endpoint) ?? null, {
        sshPath: () => '/usr/bin/ssh',
        agentEnv: () => ({})
      })
      const chunks: string[] = []
      const promise = runner({
        script: 'echo hi',
        cwd: target.remoteCwd,
        env: {},
        onChunk: (t) => chunks.push(t),
        signal: new AbortController().signal,
        ssh: target
      })
      return { promise, chunks }
    }

    it('picks the connection on the TARGET port when one user@host is live on two ports', async () => {
      const mgr = makeMgr()
      await mgr.connect('p-2022', { host: 'h', user: 'u', port: 2022 }, '/srv/app')
      await mgr.connect('p-2222', { host: 'h', user: 'u', port: 2222 }, '/srv/app')

      const { promise } = runVia(mgr, { server: { host: 'h', user: 'u', port: 2222 }, remoteCwd: '/srv/app' })
      child.emit('close', 0)
      expect((await promise).exitCode).toBe(0)
      expect(argv()).toContain(`ControlPath=${controlPathFor('p-2222')}`)
      expect(argv().join(' ')).toContain('-p 2222')
    })

    it('selects the matching identity when two projects share one user, host, port and folder', async () => {
      const mgr = makeMgr()
      await mgr.connect('key-a', { host: 'h', user: 'u', identityFile: '/key-a' }, '/srv/app')
      await mgr.connect('key-b', { host: 'h', user: 'u', identityFile: '/key-b' }, '/srv/app')
      const { promise } = runVia(mgr, { server: { host: 'h', user: 'u', identityFile: '/key-b' }, remoteCwd: '/srv/app' })
      child.emit('close', 0)
      expect((await promise).exitCode).toBe(0)
      expect(argv()).toContain(`ControlPath=${controlPathFor('key-b')}`)
    })

    it('refuses when only the WRONG-port connection is live — no spawn, no dial', async () => {
      const mgr = makeMgr()
      await mgr.connect('p-2022', { host: 'h', user: 'u', port: 2022 }, '/srv/app')

      const { promise, chunks } = runVia(mgr, { server: { host: 'h', user: 'u', port: 2222 }, remoteCwd: '/srv/app' })
      expect((await promise).exitCode).toBe(255)
      expect(chunks.join('')).toContain('u@h:2222')
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('two hosts sharing the default remoteCwd each resolve to their OWN connection', async () => {
      const mgr = makeMgr()
      await mgr.connect('p-a', { host: 'a.test', user: 'u' }, '~')
      await mgr.connect('p-b', { host: 'b.test', user: 'u' }, '~')

      const a = runVia(mgr, { server: { host: 'a.test', user: 'u' }, remoteCwd: '~' })
      child.emit('close', 0)
      expect((await a.promise).exitCode).toBe(0)
      expect(argv()).toContain(`ControlPath=${controlPathFor('p-a')}`)

      spawnMock.mockReset()
      const secondChild = new FakeChild()
      spawnMock.mockReturnValue(secondChild)
      const b = runVia(mgr, { server: { host: 'b.test', user: 'u' }, remoteCwd: '~' })
      secondChild.emit('close', 0)
      expect((await b.promise).exitCode).toBe(0)
      expect(argv()).toContain(`ControlPath=${controlPathFor('p-b')}`)
      expect(b.chunks.join('')).not.toContain('Cannot run')
    })
  })
})
