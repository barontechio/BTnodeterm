import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { testTmpDir } from './test-tmp'
import { WorkspaceStore } from './workspace-store'
import { HeadlessNodeFactory, type HeadlessNodeFactoryDeps } from './headless-node-factory'
import { FakeHeadlessPty } from './test-headless-pty'
import { GitService } from './git-service'
import { makeWorktreeControlBackend } from './worktree-control-backend'
import { DEFAULT_SETTINGS } from '../shared/types'

describe('shared host worktree control with real Git and persisted canvas state', () => {
  let root: string
  let repo: string
  let workspace: WorkspaceStore
  let factory: HeadlessNodeFactory
  let git: GitService
  let pty: FakeHeadlessPty
  let deps: HeadlessNodeFactoryDeps
  let prepare: ReturnType<typeof vi.fn<(projectId: string, directory: string) => Promise<void>>>
  const project = async () => (await workspace.load()).projects[0]
  const open = (args: Record<string, string> = {}) => factory.worktree('open-worktree', 'source', { branch: 'feature', ...args }, true)

  beforeEach(async () => {
    root = testTmpDir('host-worktree-'); repo = path.join(root, 'repo')
    fs.mkdirSync(repo); fs.mkdirSync(path.join(root, 'data'))
    execFileSync('git', ['init', '-b', 'main', repo], { stdio: 'ignore' })
    execFileSync('git', ['-C', repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'initial'], { stdio: 'ignore' })
    resetPlatformForTests(); initPlatform(fakePlatform({ userDataDir: path.join(root, 'data') }))
    workspace = new WorkspaceStore(); git = new GitService(); pty = new FakeHeadlessPty(); prepare = vi.fn(async () => {})
    await workspace.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Repository', cwd: repo,
      color: '#0a84ff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'source', kind: 'terminal', agentId: 'claude', title: 'Director', color: '#0a84ff', group: null,
        position: { x: 0, y: 0 }, size: { width: 640, height: 440 } }] }] })
    deps = { workspaceStore: workspace, ptyManager: pty, controlScope: 'project', settings: () => DEFAULT_SETTINGS,
      stateOf: () => 'working', cliCaps: async () => ({ version: null, autoPermissionMode: false, fullscreenTui: false, sessionIdFlag: false }),
      grokCaps: async () => ({ sessionIdFlag: false, models: [] }), codexCaps: async () => ({ approvalValues: null }),
      codexSharedIdentity: async () => false, publishMutation: () => {}, worktrees: { git, prepare } }
    factory = new HeadlessNodeFactory(deps)
  })
  afterEach(() => { factory.stop(); vi.restoreAllMocks(); resetPlatformForTests() })

  it('creates and prepares one checkout, binds its frame, and unbinds without deleting files or sessions', async () => {
    prepare.mockImplementation(async (_id, directory) => {
      expect(fs.existsSync(directory)).toBe(true)
      expect((await project()).nodes).toHaveLength(1)
    })
    const reply = await open()
    expect(reply.ok).toBe(true)
    const result = reply.result as { groupId: string; path: string }
    expect(prepare).toHaveBeenCalledWith('p', result.path)
    expect((await project()).nodes.find((n) => n.id === result.groupId)).toMatchObject({
      kind: 'group', openedBy: 'source', worktree: { branch: 'feature', path: result.path, createdByApp: true }
    })
    fs.writeFileSync(path.join(result.path, 'uncommitted.txt'), 'keep this')
    expect(await factory.worktree('close-worktree', 'source', { group: result.groupId }, true)).toMatchObject({ ok: true })
    expect((await project()).nodes.find((n) => n.id === result.groupId)!.worktree).toBeUndefined()
    expect(fs.readFileSync(path.join(result.path, 'uncommitted.txt'), 'utf8')).toBe('keep this')
    expect(pty.creates).toEqual([]); expect(pty.destroys).toEqual([])
  })

  it('serializes competing station requests and resolves --base through the actual binding', async () => {
    const replies = await Promise.all([open(), open()])
    expect(replies.filter((r) => r.ok)).toHaveLength(1)
    const group = (replies.find((r) => r.ok)!.result as { groupId: string }).groupId
    expect(await open({ branch: 'child', base: group })).toMatchObject({ ok: true, result: { baseRef: 'feature', baseStation: group } })
    expect((await git.worktreeList(repo)).entries).toHaveLength(3)
  })

  it('opens members inside the bound frame using its checkout rather than the director cwd', async () => {
    const opened = await open()
    const { groupId, path: directory } = opened.result as { groupId: string; path: string }
    const member = await factory.openAgent('source', { agent: 'claude', group: groupId, prompt: 'work here' }, true)
    expect(member.ok).toBe(true)
    const nodeId = (member.result as { id: string }).id
    expect((await project()).nodes.find((n) => n.id === nodeId)).toMatchObject({ parentId: groupId, cwd: directory })
    expect(pty.creates[0]).toMatchObject({ cwd: directory, persistKey: nodeId })
    const binding = (await project()).nodes.find((n) => n.id === groupId)!.worktree
    vi.spyOn(git, 'worktreeList').mockResolvedValueOnce({ ok: false, entries: [] })
    expect(await factory.openAgent('source', { agent: 'claude', group: groupId }, true)).toMatchObject({ ok: false })
    expect((await project()).nodes.find((n) => n.id === groupId)!.worktree).toEqual(binding)
    expect(pty.creates).toHaveLength(1)
  })

  it('uses validated project settings to materialize shared paths before the trust-gated setup', async () => {
    fs.mkdirSync(path.join(repo, 'node_modules'))
    fs.writeFileSync(path.join(repo, 'node_modules', 'marker'), 'dependency')
    vi.spyOn(workspace, 'readProjectSettings').mockResolvedValue({ shared: null,
      local: { worktree: { sharedPaths: ['node_modules'] } } })
    const runAndWait = vi.fn(async (target: { projectId: string; worktreePath?: string }) => {
      expect(target.projectId).toBe('p')
      expect(fs.readFileSync(path.join(target.worktreePath!, 'node_modules', 'marker'), 'utf8')).toBe('dependency')
      return true
    })
    factory.stop(); factory = new HeadlessNodeFactory({ ...deps,
      worktrees: makeWorktreeControlBackend(workspace, git, { runAndWait }, undefined) })
    expect(await open()).toMatchObject({ ok: true })
    expect(runAndWait).toHaveBeenCalledTimes(1)
  })

  it('dry-runs through the same validation without creating a directory, binding or setup run', async () => {
    const reply = await open({ 'dry-run': '' })
    expect(reply).toMatchObject({ ok: true, result: { dryRun: true, baseRef: 'main' } })
    expect(fs.existsSync((reply.result as { path: string }).path)).toBe(false)
    expect(prepare).not.toHaveBeenCalled(); expect((await project()).nodes).toHaveLength(1)
    expect(await open({ base: 'source', 'dry-run': '' })).toMatchObject({ ok: false })
  })

  it('keeps a successful checkout recoverable after setup or binding fails', async () => {
    prepare.mockRejectedValueOnce(new Error('setup failed'))
    const failed = await open()
    expect(failed).toMatchObject({ ok: false, error: expect.stringContaining('binding-uncertain') })
    const directory = (failed.result as { path: string }).path
    expect(fs.existsSync(directory)).toBe(true)
    expect((await project()).nodes).toHaveLength(1)
    expect((await git.worktreeList(repo)).entries.some((e) => e.path === directory)).toBe(true)
    expect(await open()).toMatchObject({ ok: false })
  })

  it('does not bind a checkout to a project whose folder changed during preparation', async () => {
    prepare.mockImplementationOnce(async () => {
      await workspace.updateWorkspace((fresh) => { fresh.projects[0].cwd = root; return fresh })
    })
    const reply = await open()
    expect(reply).toMatchObject({ ok: false, result: { worktree: { branch: 'feature' } } })
    expect((await project()).nodes).toHaveLength(1)
    expect((await git.worktreeList(repo)).entries).toHaveLength(2)
  })

  it('preserves the Git result if the canvas save fails after reflected mutations', async () => {
    prepare.mockImplementationOnce(async () => {
      vi.spyOn(workspace, 'updateWorkspace').mockRejectedValueOnce(new Error('disk full'))
    })
    const reply = await open()
    expect(reply).toMatchObject({ ok: false, result: { worktree: { createdByApp: true } } })
    expect((await git.worktreeList(repo)).entries).toHaveLength(2)
    expect(pty.creates).toEqual([])
  })

  it('refuses missing checkout unbind, unverified callers, unknown flags and removal without confirmation', async () => {
    expect(await factory.worktree('open-worktree', 'source', { branch: 'feature' }, false)).toMatchObject({ ok: false })
    expect(await open({ unsafe: 'true' })).toMatchObject({ ok: false })
    const created = await open()
    const group = (created.result as { groupId: string }).groupId
    expect(await factory.worktree('close-worktree', 'source', { group, mode: 'remove' }, true)).toMatchObject({ ok: false, error: expect.stringContaining('confirmation-required') })
    vi.spyOn(git, 'worktreeList').mockResolvedValue({ ok: false, entries: [] })
    expect(await factory.worktree('close-worktree', 'source', { group }, true)).toMatchObject({ ok: false, error: expect.stringContaining('recovery-required') })
    expect((await project()).nodes.find((n) => n.id === group)!.worktree).toBeDefined()
  })

  it('does not grant creator rights to a saved group after restart', async () => {
    const created = await open()
    const group = (created.result as { groupId: string }).groupId
    factory.stop(); factory = new HeadlessNodeFactory({ ...deps, controlScope: 'creator' })
    expect(await factory.worktree('close-worktree', 'source', { group }, true)).toMatchObject({ ok: false })
    expect((await project()).nodes.find((n) => n.id === group)!.worktree).toBeDefined()
  })
})
