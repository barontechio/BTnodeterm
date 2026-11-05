import { describe, expect, it, vi } from 'vitest'
import { reportIssueFromControl } from './control-report-issue'
import { emptyLedger } from './report-issue-core'
import type { ReportIssueClient, ReportIssueDeps } from './report-issue-service'

const args = { kind: 'verb-unsupported', title: 'A product gap', body: 'A reproducible description' }
function fixture() {
  const effect = vi.fn(() => { throw new Error('a preview must not publish') })
  const client: ReportIssueClient = { listIssues: effect, createIssue: effect, createIssueComment: effect,
    listRepositoryLabels: effect, createLabel: effect }
  const service: ReportIssueDeps = { contextForProject: vi.fn(async () => ({ repository: 'owner/project', client })),
    granted: vi.fn(() => true), loadLedger: async () => emptyLedger(), saveLedger: effect,
    env: { version: 'test', os: 'linux', edition: 'server' } }
  const deps = { service, projectIdsForNode: vi.fn(() => ['project']) }
  return { deps, service, effect }
}

describe('shared issue reporting control entrance', () => {
  it('refuses identity, ambiguous membership and foreign project flags before publication', async () => {
    const f = fixture()
    expect(await reportIssueFromControl({ nodeId: 'source', args, verified: false }, f.deps)).toMatchObject({ ok: false })
    f.deps.projectIdsForNode.mockReturnValue(['a', 'b'])
    expect(await reportIssueFromControl({ nodeId: 'source', args, verified: true }, f.deps)).toMatchObject({ ok: false, error: expect.stringContaining('report-no-project') })
    f.deps.projectIdsForNode.mockReturnValue(['project'])
    expect(await reportIssueFromControl({ nodeId: 'source', args: { ...args, project: 'foreign' }, verified: true }, f.deps)).toMatchObject({ ok: false, error: expect.stringContaining('flag-unsupported') })
    expect(f.service.granted).not.toHaveBeenCalled(); expect(f.effect).not.toHaveBeenCalled()
  })

  it('keeps reporting off without the grant and renders a redacted dry-run for the own repository', async () => {
    const f = fixture()
    f.service.granted = () => false
    expect(await reportIssueFromControl({ nodeId: 'source', args, verified: true }, f.deps)).toMatchObject({ ok: false, error: 'report-disabled' })
    expect(f.service.contextForProject).not.toHaveBeenCalled()
    f.service.granted = () => true
    const preview = await reportIssueFromControl({ nodeId: 'source', args: { ...args, body: 'failure in /home/alice/private/file.ts', 'dry-run': '' }, verified: true }, f.deps)
    expect(preview.ok).toBe(true)
    expect(preview.message).toContain('owner/project')
    expect(preview.message).not.toContain('/home/alice')
    expect(f.effect).not.toHaveBeenCalled()
    expect(f.service.contextForProject).toHaveBeenCalledWith('project')
  })

  it('refuses overlapping publication instead of queuing a late external effect', async () => {
    const f = fixture()
    let release!: (value: boolean) => void
    f.service.granted = () => new Promise((resolve) => { release = resolve })
    const first = reportIssueFromControl({ nodeId: 'source', args, verified: true }, f.deps)
    expect(await reportIssueFromControl({ nodeId: 'source', args, verified: true }, f.deps)).toMatchObject({ ok: false, error: expect.stringContaining('report-busy') })
    release(false)
    expect(await first).toMatchObject({ ok: false, error: 'report-disabled' })
    f.service.granted = () => false
    expect(await reportIssueFromControl({ nodeId: 'source', args, verified: true }, f.deps)).toMatchObject({ error: 'report-disabled' })
    expect(f.effect).not.toHaveBeenCalled()
  })
})
