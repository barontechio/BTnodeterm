import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import path from 'path'
import { sanitizeNodeParents } from '../shared/stored-canvas-geometry'
import type { CanvasNodeState, Project } from '../shared/types'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, makeFakeUserDataDir } from './platform-fake'
import { testTmpDir } from './test-tmp'
import { fileToProject, projectToFile } from './workspace-files'
import { WorkspaceStore } from './workspace-store'

const node = (id: string, parentId?: string, kind: CanvasNodeState['kind'] = 'terminal'): CanvasNodeState => ({
  id,
  kind,
  position: { x: 10, y: 20 },
  size: { width: 400, height: 300 },
  title: id,
  color: '#fff',
  group: null,
  ...(parentId ? { parentId } : {})
})

const parents = (nodes: CanvasNodeState[]) => Object.fromEntries(nodes.map((n) => [n.id, n.parentId]))

describe('sanitizeNodeParents', () => {
  it('hands a clean list back by identity, nested frames included', () => {
    const nodes = [node('outer', undefined, 'group'), node('inner', 'outer', 'group'), node('a', 'inner'), node('b')]
    expect(sanitizeNodeParents(nodes)).toBe(nodes)
  })

  it('drops a parent that is missing or is not a frame, and nothing else', () => {
    const kept = node('kept', 'frame')
    const out = sanitizeNodeParents([node('frame', undefined, 'group'), kept, node('lost', 'gone'), node('in-a-terminal', 'kept')])

    expect(parents(out)).toEqual({ frame: undefined, kept: 'frame', lost: undefined, 'in-a-terminal': undefined })
    expect(out[1]).toBe(kept)
    expect(out[2].position).toEqual({ x: 10, y: 20 })
    expect('parentId' in out[2]).toBe(false)
  })

  it('leaves a frame that lost its own parent holding its children', () => {
    const out = sanitizeNodeParents([node('frame', 'gone', 'group'), node('a', 'frame')])
    expect(parents(out)).toEqual({ frame: undefined, a: 'frame' })
  })

  it('does not touch a parent cycle: it refuses downstream, as before', () => {
    const nodes = [node('x', 'y', 'group'), node('y', 'x', 'group')]
    expect(sanitizeNodeParents(nodes)).toBe(nodes)
  })
})

describe('a dangling parentId on the load and save seams', () => {
  let userData: string
  let projRoot: string

  beforeEach(() => {
    userData = makeFakeUserDataDir()
    projRoot = testTmpDir('nt-proj-')
    initPlatform(fakePlatform({ userDataDir: userData }))
  })
  afterEach(() => {
    resetPlatformForTests()
  })

  const project = (nodes: CanvasNodeState[], cwd?: string): Project => ({
    id: 'p1',
    name: 'foo',
    color: '#7aa2f7',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    ...(cwd ? { cwd } : {})
  })

  it('never writes one into the shared file', () => {
    const file = projectToFile(project([node('a', 'gone')], projRoot), 1, 'now')
    expect(file.nodes[0].parentId).toBeUndefined()
  })

  it('never reads one out of a shared file', () => {
    const file = { ...projectToFile(project([node('a')], projRoot), 1, 'now') }
    file.nodes = [node('a', 'gone')]
    const read = fileToProject(file, { id: 'p1', cwd: projRoot })
    expect(read.nodes[0].parentId).toBeUndefined()
  })

  it('admits a folder project on load and heals its file on the next save', async () => {
    const store = new WorkspaceStore()
    await store.save({ version: 2, activeProjectId: 'p1', projects: [project([node('a')], projRoot)] })
    const file = path.join(projRoot, '.nodeterm', 'project.json')
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'))
    onDisk.nodes[0].parentId = 'gone'
    await fs.writeFile(file, JSON.stringify(onDisk))

    const loaded = await new WorkspaceStore().load()
    expect(loaded.projects[0].nodes[0].parentId).toBeUndefined()
    await new WorkspaceStore().save({ ...loaded, projects: [{ ...loaded.projects[0], name: 'renamed' }] })
    expect(JSON.parse(await fs.readFile(file, 'utf-8')).nodes[0].parentId).toBeUndefined()
  })

  it('admits an inline (cwd-less) project stored in workspace.json', async () => {
    await fs.writeFile(
      path.join(userData, 'workspace.json'),
      JSON.stringify({
        version: 3,
        activeProjectId: 'p1',
        entries: [{ id: 'p1', name: 'foo', color: '#7aa2f7', project: project([node('a', 'gone')]) }]
      })
    )
    expect((await new WorkspaceStore().load()).projects[0].nodes[0].parentId).toBeUndefined()
  })
})
