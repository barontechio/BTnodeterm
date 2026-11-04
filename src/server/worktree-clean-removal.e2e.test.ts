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
import type { Project } from '../shared/types'
import type { OwnerConfirmation } from '../shared/owner-confirmation'
import type { RpcRequest } from '../shared/rpc'
vi.mock('../core/session-host-backend', async () => (await import('../core/__fixtures__/no-session-host')).noSessionHost())

describe.skipIf(process.platform !== 'linux')('owner clean removal through actual Server WebSocket', () => {
  it('waits for owner approval and durably repairs saved nodes after real Git removal', async () => {
    const root = fs.realpathSync(testTmpDir('worktree-clean-ws-')); const dataDir = path.join(root, 'data'); const repo = path.join(root, 'repo'); const checkout = path.join(root, 'checkout')
    fs.mkdirSync(dataDir); fs.mkdirSync(repo); vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '1')
    const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    git('init', '-b', 'main'); git('config', 'user.name', 'Fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('commit', '--allow-empty', '-m', 'base')
    git('worktree', 'add', '-b', 'feature', checkout)
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    const store = new WorkspaceStore()
    const project: Project = { id: 'project', name: 'Project', color: '#fff', cwd: repo, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [
      { id: 'group', kind: 'group', title: 'Feature', color: '#fff', group: null, position: { x: 0, y: 0 }, size: { width: 400, height: 300 },
        worktree: { repoPath: repo, path: checkout, branch: 'feature', baseRef: 'main', createdByApp: true } },
      { id: 'editor', kind: 'editor', title: 'File', color: '#fff', group: null, parentId: 'group', position: { x: 0, y: 0 }, size: { width: 200, height: 100 }, filePath: path.join(checkout, 'file') }
    ] }
    await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
    const auth = new Auth(dataDir); auth.setPassword('fixture-password'); const cookie = auth.createSession()
    const server = await startServer({ dataDir, rendererDir: path.join(root, 'no-renderer'), host: '127.0.0.1', port: 0, headless: false, insecureHttp: false, installHooks: false })
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
        const id = ++serial; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ t: 'req', id, method, args } satisfies RpcRequest))
      })
      await request(IPC.ownerConfirmationConnect)
      expect(await request(IPC.worktreeRemovalDiscover)).toMatchObject({ ok: true, candidates: [{ groupId: 'group' }] })
      expect(await request(IPC.worktreeRemovalClean, '../checkout')).toMatchObject({ ok: false, outcome: 'refused' })
      const removing = request(IPC.worktreeRemovalClean, 'group')
      await vi.waitFor(() => expect(prompts).toHaveLength(1))
      expect(prompts[0].action).toBe('remove-worktree'); expect(fs.existsSync(checkout)).toBe(true)
      expect(fs.existsSync(path.join(dataDir, 'worktree-removals.json'))).toBe(false)
      const prompt = prompts[0]
      expect(await request(IPC.ownerConfirmationDecide, { id: prompt.id, token: prompt.token, proof: prompt.proof, answer: 'approve' })).toBe(true)
      const result = await removing
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, outcome: 'recovered' })
      expect(fs.existsSync(checkout)).toBe(false); expect(git('branch', '--list', 'feature')).toContain('feature')
      const saved = await request(IPC.workspaceLoad) as Awaited<ReturnType<WorkspaceStore['load']>>
      expect(saved.projects[0].nodes).toHaveLength(2)
      expect(saved.projects[0].nodes.find(n => n.id === 'group')?.worktree).toBeUndefined()
      expect(saved.projects[0].nodes.find(n => n.id === 'editor')).toMatchObject({ fileMissing: true, filePath: path.join(checkout, 'file') })
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'worktree-removals.json'), 'utf8')).records[0].phase).toBe('recovered')
    } finally { socket?.terminate(); await server.close(); resetPlatformForTests(); vi.unstubAllEnvs() }
  })
})
