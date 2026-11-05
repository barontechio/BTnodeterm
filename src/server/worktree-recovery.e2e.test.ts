import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { startServer } from './index'
import { Auth } from './auth'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { testTmpDir } from '../core/test-tmp'
import { IPC } from '../shared/ipc'
import { WorkspaceStore } from '../core/workspace-store'
import { WorktreeRemovalJournal } from '../core/worktree-removal-journal'
import { canvasExecutionBinding } from '../core/canvas-execution-reservations'
import { DEFAULT_SETTINGS, type Project } from '../shared/types'
import { SettingsStore } from '../core/settings-store'
import type { OwnerConfirmation } from '../shared/owner-confirmation'
import type { RpcRequest } from '../shared/rpc'

// This suite measures actual plain Linux PTYs, independent of any prior session-host build.
vi.mock('../core/session-host-backend', async () => (await import('../core/__fixtures__/no-session-host')).noSessionHost())

describe.skipIf(process.platform === 'win32')('owner worktree recovery through a real Server WebSocket', () => {
  it('inspects and keeps the original dirty checkout without replaying Git removal or starting a session', async () => {
    const root = fs.realpathSync(testTmpDir('worktree-recovery-e2e-'))
    const dataDir = path.join(root, 'data'); const repo = path.join(root, 'repo'); const checkout = path.join(root, 'checkout')
    const home = path.join(root, 'home'); fs.mkdirSync(home); fs.mkdirSync(dataDir); fs.mkdirSync(repo)
    vi.stubEnv('HOME', home); vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '1')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid')
    fs.writeFileSync(path.join(repo, 'tracked'), 'base'); git('add', 'tracked'); git('commit', '-m', 'base')
    git('worktree', 'add', '-b', 'feature', checkout)
    fs.writeFileSync(path.join(checkout, 'unfinished'), 'do not lose this')
    const stat = fs.lstatSync(checkout, { bigint: true })
    const journal = path.join(dataDir, 'worktree-removals.json')
    fs.writeFileSync(journal, JSON.stringify({ kind: 'worktree-removals', version: 1, records: [{
      id: 'prepared-recovery', phase: 'prepared', createdAt: Date.now(), projectId: 'project', groupId: 'group',
      repoPath: repo, worktreePath: checkout, branch: 'feature', fallbackCwd: repo, directoryStamp: `${stat.dev}:${stat.ino}`,
      members: [{ nodeId: 'group', binding: 'a'.repeat(64) }]
    }] }))
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    const auth = new Auth(dataDir); auth.setPassword('fixture-password'); const cookie = auth.createSession()
    const server = await startServer({ dataDir, rendererDir: path.join(root, 'no-renderer'), host: '127.0.0.1', port: 0,
      headless: false, insecureHttp: false, installHooks: false })
    let socket: WebSocket | undefined
    try {
      socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie: `nt_session=${cookie}` } })
      let serial = 0
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
      socket.on('message', (data, binary) => {
        if (binary) return
        const message = JSON.parse(data.toString())
        if (message.t !== 'res') return
        const entry = pending.get(message.id); pending.delete(message.id)
        if (message.ok) entry?.resolve(message.result); else entry?.reject(new Error(message.error.message))
      })
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
      const request = (method: string, ...args: unknown[]) => new Promise<unknown>((resolve, reject) => {
        const id = ++serial; pending.set(id, { resolve, reject })
        socket!.send(JSON.stringify({ t: 'req', id, method, args } satisfies RpcRequest))
      })
      expect(await request(IPC.worktreeRecoveryList)).toMatchObject({ ok: true, records: [{ id: 'prepared-recovery', path: checkout }] })
      expect(await request(IPC.worktreeRecoveryInspect, 'prepared-recovery')).toMatchObject({ ok: true, status: 'kept' })
      await expect(request(IPC.ptyCreate, { persistKey: 'group', cwd: checkout, cols: 80, rows: 24 })).rejects.toThrow('worktree-recovery-required')
      expect(await request(IPC.worktreeRecoveryKeep, '../checkout')).toMatchObject({ ok: false, outcome: 'refused' })
      expect(await request(IPC.worktreeRecoveryKeep, 'prepared-recovery')).toMatchObject({ ok: true, outcome: 'kept' })
      expect(await request(IPC.worktreeRecoveryList)).toEqual({ ok: true, records: [] })
      expect(fs.readFileSync(path.join(checkout, 'unfinished'), 'utf8')).toBe('do not lose this')
      expect(git('worktree', 'list', '--porcelain')).toContain(checkout)
      expect(git('branch', '--list', 'feature')).toContain('feature')
      expect(JSON.parse(fs.readFileSync(journal, 'utf8')).records).toEqual([])
      expect((fs.statSync(journal).mode & 0o777)).toBe(0o600)
    } finally {
      socket?.terminate(); await server.close(); resetPlatformForTests(); vi.unstubAllEnvs()
    }
  })
  it.each([true, false])('recovers a recorded missing binding only after the real owner broker approves its immutable plan', async (recorded) => {
    const root = fs.realpathSync(testTmpDir('worktree-repair-e2e-'))
    const dataDir = path.join(root, 'data'); const repo = path.join(root, 'repo'); const checkout = path.join(root, 'checkout')
    fs.mkdirSync(dataDir); fs.mkdirSync(repo); fs.mkdirSync(checkout)
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe' })
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('commit', '--allow-empty', '-m', 'base')
    vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '1')
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    await new SettingsStore().save({ ...DEFAULT_SETTINGS, tmuxEnabled: false })
    const store = new WorkspaceStore()
    const project: Project = { id: 'project', name: 'Project', color: '#fff', cwd: repo, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
      { id: 'group', kind: 'group', title: 'Feature', color: '#fff', group: null, position: { x: 0, y: 0 }, size: { width: 400, height: 300 },
        worktree: { repoPath: repo, path: checkout, branch: 'feature', baseRef: 'main', createdByApp: true } },
      { id: 'editor', kind: 'editor', title: 'File', color: '#fff', group: null, parentId: 'group', position: { x: 0, y: 0 }, size: { width: 200, height: 100 },
        filePath: path.join(checkout, 'file') },
      { id: 'resume-terminal', kind: 'terminal', title: 'Shell', color: '#fff', group: null, parentId: 'group',
        position: { x: 0, y: 0 }, size: { width: 300, height: 200 }, cwd: checkout, shell: '/bin/bash',
        pendingLaunch: { after: [], command: 'touch FORBIDDEN_REPLAY', attempted: false } }
    ] }
    await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
    const persisted = (await store.load()).projects[0]
    const journal = new WorktreeRemovalJournal(path.join(dataDir, 'worktree-removals.json'), { ownsFiles: () => true })
    await journal.load(); const stat = fs.lstatSync(checkout, { bigint: true })
    const row = recorded ? await journal.prepare({ projectId: project.id, groupId: 'group', repoPath: repo, worktreePath: checkout, branch: 'feature',
      fallbackCwd: repo, directoryStamp: `${stat.dev}:${stat.ino}`,
      members: persisted.nodes.map((node) => ({ nodeId: node.id, binding: canvasExecutionBinding(persisted, node) })) }) : undefined
    fs.rmdirSync(checkout)
    const auth = new Auth(dataDir); auth.setPassword('fixture-password'); const cookie = auth.createSession()
    const server = await startServer({ dataDir, rendererDir: path.join(root, 'no-renderer'), host: '127.0.0.1', port: 0,
      headless: false, insecureHttp: false, installHooks: false })
    let socket: WebSocket | undefined
    try {
      socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie: `nt_session=${cookie}` } })
      let serial = 0; const prompts: OwnerConfirmation[] = []
      const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
      socket.on('message', (data, binary) => {
        if (binary) return
        const message = JSON.parse(data.toString())
        if (message.t === 'ev' && message.channel === IPC.ownerConfirmationRequest) prompts.push(message.args[0])
        if (message.t !== 'res') return
        const entry = pending.get(message.id); pending.delete(message.id)
        if (message.ok) entry?.resolve(message.result); else entry?.reject(new Error(message.error.message))
      })
      await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
      const request = (method: string, ...args: unknown[]) => new Promise<unknown>((resolve, reject) => {
        const id = ++serial; pending.set(id, { resolve, reject })
        socket!.send(JSON.stringify({ t: 'req', id, method, args } satisfies RpcRequest))
      })
      await request(IPC.ownerConfirmationConnect)
      if (!recorded) expect(await request(IPC.worktreeRecoveryDiscover)).toMatchObject({ ok: true, candidates: [{ groupId: 'group' }] })
      const recovering = recorded ? request(IPC.worktreeRecoveryRepair, row!.id) : request(IPC.worktreeRecoveryMissing, 'group')
      await vi.waitFor(() => expect(prompts).toHaveLength(1))
      expect(prompts[0].action).toBe('recover-worktree')
      if (recorded) expect(JSON.parse(fs.readFileSync(journal.file, 'utf8')).records[0].phase).toBe('prepared')
      else expect(fs.existsSync(journal.file)).toBe(false)
      const prompt = prompts[0]
      await request(IPC.ownerConfirmationDecide, { id: prompt.id, token: prompt.token, proof: prompt.proof, answer: 'approve' })
      expect(await recovering).toMatchObject({ ok: true, outcome: 'recovered' })
      const saved = await request(IPC.workspaceLoad) as Awaited<ReturnType<WorkspaceStore['load']>>
      expect(saved.projects[0].nodes.find((node) => node.id === 'group')?.worktree).toBeUndefined()
      expect(saved.projects[0].nodes.find((node) => node.id === 'editor')).toMatchObject({ fileMissing: true, filePath: path.join(checkout, 'file') })
      await expect(request(IPC.ptyCreate, { persistKey: 'new-node', cwd: checkout, cols: 80, rows: 24 })).rejects.toThrow('worktree-recovery-required')
      const facts = JSON.parse(fs.readFileSync(journal.file, 'utf8')).records[0]
      expect(facts.phase).toBe('recovered')
      expect(facts.provenance.kind).toBe(recorded ? 'recorded-directory' : 'observed-missing')
      if (!recorded) expect(facts.directoryStamp).toBeUndefined()
      git('worktree', 'add', '-b', 'feature', checkout)
      const rebinding = request(IPC.worktreeRecoveryRebind, facts.id)
      await vi.waitFor(() => expect(prompts).toHaveLength(2))
      expect(prompts[1].action).toBe('rebind-worktree')
      expect(JSON.parse(fs.readFileSync(journal.file, 'utf8')).records[0].rebind).toBeUndefined()
      const consent = prompts[1]
      await request(IPC.ownerConfirmationDecide, { id: consent.id, token: consent.token, proof: consent.proof, answer: 'approve' })
      expect(await rebinding).toMatchObject({ ok: true, outcome: 'rebound' })
      const rebound = await request(IPC.workspaceLoad) as Awaited<ReturnType<WorkspaceStore['load']>>
      expect(rebound.projects[0].nodes.find((node) => node.id === 'group')).toMatchObject({ cwd: checkout,
        worktree: { repoPath: repo, path: checkout, branch: 'feature', baseRef: 'main', createdByApp: false } })
      expect(rebound.projects[0].nodes.find((node) => node.id === 'editor')?.fileMissing).toBe(true)
      expect(await request(IPC.worktreeRecoveryList)).toMatchObject({ ok: true, records: [{ pathRestricted: false }] })
      expect(JSON.parse(fs.readFileSync(journal.file, 'utf8')).records[0]).toMatchObject({ phase: 'recovered', rebind: { state: 'bound' } })
      if (process.platform === 'linux') {
        const resuming = request(IPC.worktreeRecoveryResume, facts.id, 'resume-terminal')
        await vi.waitFor(() => expect(prompts).toHaveLength(3), { timeout: 10000 })
        expect(prompts[2].action).toBe('resume-worktree-terminal')
        await expect(request(IPC.ptyCreate, { persistKey: 'resume-terminal', cwd: repo, cols: 80, rows: 24 })).rejects.toThrow('worktree-recovery-required')
        const start = prompts[2]
        await request(IPC.ownerConfirmationDecide, { id: start.id, token: start.token, proof: start.proof, answer: 'approve' })
        const result = await resuming
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, outcome: 'resumed' })
        const created = await request(IPC.ptyCreate, { persistKey: 'resume-terminal', cwd: repo, cols: 80, rows: 24 }) as { sessionId: string; fresh: boolean }
        expect(created.fresh).toBe(false)
        expect(created.sessionId).toBeTruthy()
        expect(await request(IPC.worktreeRecoveryList)).toMatchObject({ ok: true, records: [{ manualStartIds: ['resume-terminal'], manualActiveIds: ['resume-terminal'] }] })
        expect(fs.existsSync(path.join(repo, 'FORBIDDEN_REPLAY'))).toBe(false)
        expect(JSON.parse(fs.readFileSync(journal.file, 'utf8')).records[0].manualResume).toMatchObject([{ state: 'observed', evidence: { backend: 'plain' } }])
      }


    } finally { socket?.terminate(); await server.close(); resetPlatformForTests(); vi.unstubAllEnvs() }
  })

})
