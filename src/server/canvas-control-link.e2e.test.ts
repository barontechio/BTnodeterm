// `link` under the default creator scope, through what an agent actually runs: the generated shim,
// the real hook server, the per-node capability on disk, and the context shim reading the result.
// The factory suite pins the rules; this pins that a verified caller reaches them and that the link
// it makes is one the caller can read back.
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { startServer } from './index'
import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { hookServer } from '../core/agents/hook-server'
import { testTmpDir } from '../core/test-tmp'

const run = promisify(execFile)

describe.skipIf(process.platform === 'win32')('link through the generated CLI (creator scope)', () => {
  it('links the caller to a node it opened, refuses a foreign node, and refuses an unverified caller', async () => {
    vi.stubEnv('NODETERM_TELEMETRY_DISABLED', '1')
    const root = testTmpDir('canvas-link-e2e-')
    const dataDir = path.join(root, 'data')
    const cwd = path.join(root, 'project')
    fs.mkdirSync(dataDir)
    fs.mkdirSync(cwd)
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    const store = new WorkspaceStore()
    const agent = (id: string) => ({
      id,
      kind: 'terminal' as const,
      agentId: 'claude' as const,
      title: id,
      color: '#000',
      group: null,
      position: { x: 0, y: 0 },
      size: { width: 640, height: 440 },
      cwd
    })
    await store.save({
      version: 2,
      activeProjectId: 'p',
      projects: [
        { id: 'p', name: 'Project', cwd, color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [agent('source'), agent('foreign')] },
        { id: 'other', name: 'Other', color: '#000', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [agent('private')] }
      ]
    })
    const bridgesOfP = async () => (await store.load()).projects.find((p) => p.id === 'p')!.bridges ?? []

    const server = await startServer({
      dataDir,
      rendererDir: path.join(root, 'no-renderer'),
      host: '127.0.0.1',
      port: 0,
      headless: false,
      insecureHttp: false,
      installHooks: false,
      licenseEnabled: true,
      canvasControl: true
    })
    try {
      const env = {
        ...process.env,
        NODETERM_CANVAS_CONTROL: '1',
        NODETERM_NODE_ID: 'source',
        NODETERM_HOOK_ENDPOINT: hookServer.endpointFilePath()
      }
      const cli = async (...args: string[]) =>
        (await run('/bin/sh', [path.join(dataDir, 'canvas-control', 'nodeterm.sh'), ...args], { env, timeout: 15_000 })).stdout
      const contextList = async () =>
        (await run('/bin/sh', [path.join(dataDir, 'context-links', 'context.sh'), 'list'], { env, timeout: 15_000 })).stdout

      // A sticky is a node this caller really opens in this run, with no agent CLI to launch.
      expect(await cli('sticky', '--node', 'Station note', '--create', 'yes', '--text', 'station output')).toContain('created sticky')
      const note = (await store.load()).projects.find((p) => p.id === 'p')!.nodes.find((n) => n.kind === 'sticky')!

      // The caller's own node was the one refused here before: it never opened itself.
      expect(await cli('link', '--to', note.id)).toContain(note.id)
      expect(await bridgesOfP()).toEqual([expect.objectContaining({ source: note.id, target: 'source' })])
      await vi.waitFor(async () => expect(await contextList()).toContain(note.id), { timeout: 5_000 })

      await expect(cli('link', '--to', 'foreign')).rejects.toMatchObject({
        stderr: expect.stringContaining('link-not-owner: source may modify only')
      })
      await expect(cli('link', '--from', 'foreign', '--to', 'source')).rejects.toMatchObject({
        stderr: expect.stringContaining('link-not-owner: source may modify only')
      })
      await expect(cli('link', '--to', 'private')).rejects.toMatchObject({
        stderr: expect.stringContaining('link-project-refused: private')
      })
      expect(await bridgesOfP()).toHaveLength(1)

      // The exception is for link alone: the same verified caller still cannot rename itself.
      await expect(cli('rename', '--node', 'source', '--title', 'Mine now')).rejects.toMatchObject({
        stderr: expect.stringContaining('rename-not-owner')
      })

      // Take the capability away and the caller is no longer verified, whatever id it claims.
      const tokenFile = path.join(dataDir, 'node-tokens', 'source')
      const token = fs.readFileSync(tokenFile)
      fs.rmSync(tokenFile)
      try {
        await expect(cli('link', '--to', note.id)).rejects.toMatchObject({
          stderr: expect.stringMatching(/refused|identity/)
        })
      } finally {
        fs.writeFileSync(tokenFile, token, { mode: 0o600 })
      }
      expect(await bridgesOfP()).toHaveLength(1)
    } finally {
      await server.close()
      resetPlatformForTests()
      vi.unstubAllEnvs()
    }
  }, 30_000)
})
