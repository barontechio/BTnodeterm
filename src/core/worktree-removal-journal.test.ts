import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { WorktreeRemovalJournal, type WorktreeRemovalIntent } from './worktree-removal-journal'
import { writeFileDurableAtomic } from './fs-atomic'
import { testTmpDir } from './test-tmp'

function fixture(options: Partial<ConstructorParameters<typeof WorktreeRemovalJournal>[1]> = {}) {
  const root = fs.realpathSync(testTmpDir('worktree-journal-')); const file = path.join(root, 'removals.json')
  const config = { ownsFiles: () => true, ...options }
  const journal = new WorktreeRemovalJournal(file, config)
  const intent: WorktreeRemovalIntent = { projectId: 'project', groupId: 'group', repoPath: path.join(root, 'repo'),
    worktreePath: path.join(root, 'checkout'), fallbackCwd: path.join(root, 'repo'), branch: 'feature',
    directoryStamp: '1:2', members: [{ nodeId: 'group', binding: 'a'.repeat(64) }] }
  return { root, file, config, journal, intent }
}

describe.skipIf(process.platform === 'win32')('strict write-ahead worktree recovery facts', () => {
  it('survives process reconstruction at every phase and retains the recovered path tombstone', async () => {
    const f = fixture(); expect(await f.journal.load()).toEqual([])
    const prepared = await f.journal.prepare(f.intent)
    expect(f.journal.isNodePending('group')).toBe(true)
    expect((fs.statSync(f.file).mode & 0o777)).toBe(0o600)
    const resumed = new WorktreeRemovalJournal(f.file, f.config)
    expect(await resumed.load()).toEqual([prepared])
    await expect(resumed.markRecovered(prepared.id)).rejects.toThrow('invalid-transition')
    await resumed.markRemoved(prepared.id)
    expect(resumed.isNodePending('group')).toBe(true)
    await resumed.markRecovered(prepared.id)
    expect(resumed.isNodePending('group')).toBe(false)
    const final = new WorktreeRemovalJournal(f.file, f.config)
    expect(await final.load()).toMatchObject([{ phase: 'recovered' }])
    expect(final.blocks(f.intent.worktreePath)).toBe(true)
    expect(final.blocks(path.join(f.intent.worktreePath, 'child'))).toBe(true)
    expect(final.blocks(f.intent.fallbackCwd)).toBe(false)
    await expect(final.prepare(f.intent)).rejects.toThrow('path-reserved')
    await final.releaseRebound(prepared.id)
    expect(final.blocks(f.intent.worktreePath)).toBe(false)
  })

  it('snapshots queued intent inputs and serializes competing or overlapping directories', async () => {
    const f = fixture(); await f.journal.load()
    const first = f.journal.prepare(f.intent)
    const competing = f.journal.prepare({ ...f.intent, worktreePath: path.join(f.intent.worktreePath, 'nested') })
    void competing.catch(() => {})
    f.intent.branch = 'mutated'; f.intent.members[0].binding = 'b'.repeat(64)
    expect(await first).toMatchObject({ branch: 'feature', members: [{ binding: 'a'.repeat(64) }] })
    await expect(competing).rejects.toThrow('path-reserved')
    const copy = f.journal.list(); copy[0].branch = 'outside'
    expect(f.journal.list()[0].branch).toBe('feature')
  })

  it.each(['invalid JSON', 'unknown version', 'invalid record', 'duplicate record', 'too many records'])(
    'preserves a journal with %s and refuses edits', async (issue) => {
      const f = fixture(); await f.journal.load(); const saved = await f.journal.prepare(f.intent)
      const envelope = { kind: 'worktree-removals', version: 1, records: [saved] }
      if (issue === 'unknown version') envelope.version = 99
      if (issue === 'invalid record') envelope.records[0].members[0].binding = 'invalid'
      if (issue === 'duplicate record') envelope.records.push(saved)
      if (issue === 'too many records') envelope.records = Array.from({ length: 129 }, () => saved)
      const damaged = issue === 'invalid JSON' ? '{broken' : JSON.stringify(envelope)
      fs.writeFileSync(f.file, damaged)
      await expect(f.journal.load()).rejects.toThrow()
      await expect(f.journal.prepare(f.intent)).rejects.toThrow('unavailable')
      expect(fs.readFileSync(f.file, 'utf8')).toBe(damaged)
    }
  )

  it('refuses a symlink journal without reading or replacing its target', async () => {
    const f = fixture(); const other = path.join(f.root, 'other'); fs.writeFileSync(other, 'keep this')
    fs.symlinkSync(other, f.file)
    await expect(f.journal.load()).rejects.toThrow('unreadable')
    await expect(f.journal.prepare(f.intent)).rejects.toThrow('unavailable')
    expect(fs.readFileSync(other, 'utf8')).toBe('keep this')
    expect(fs.lstatSync(f.file).isSymbolicLink()).toBe(true)
  })

  it('requires reload after a lost publication acknowledgement, preserving the actual recovery record', async () => {
    const f = fixture({ persist: async (file, data) => { await writeFileDurableAtomic(file, data, { mode: 0o600 }); throw new Error('ack lost') } })
    await f.journal.load()
    await expect(f.journal.prepare(f.intent)).rejects.toThrow('ack lost')
    expect(() => f.journal.list()).toThrow('unavailable')
    const fresh = new WorktreeRemovalJournal(f.file, { ownsFiles: () => true })
    expect(await fresh.load()).toMatchObject([{ phase: 'prepared', branch: 'feature' }])
    await expect(fresh.prepare(f.intent)).rejects.toThrow('path-reserved')
    await expect(fresh.releaseRebound(fresh.list()[0].id)).rejects.toThrow('recovery-required')
  })

  it('refuses unsafe recovery metadata before any publication', async () => {
    const persist = vi.fn(); const f = fixture({ persist }); await f.journal.load()
    for (const bad of [{ branch: '--force' }, { fallbackCwd: f.intent.worktreePath }, { directoryStamp: '1:0' }, { members: [] },
      { members: [{ nodeId: 'group', binding: 'a'.repeat(64), command: 'must not be journaled' }] }]) {
      await expect(f.journal.prepare({ ...f.intent, ...bad })).rejects.toThrow(/invalid-(record|provenance)/)
    }
    expect(persist).not.toHaveBeenCalled(); expect(f.journal.list()).toEqual([])
  })

  it('requires actual data-directory ownership and reload after that ownership is lost', async () => {
    let owner = true; const f = fixture({ ownsFiles: () => owner }); await f.journal.load()
    owner = false
    await expect(f.journal.prepare(f.intent)).rejects.toThrow('owner-required')
    owner = true
    await expect(f.journal.prepare(f.intent)).rejects.toThrow('unavailable')
    await f.journal.load(); expect(await f.journal.prepare(f.intent)).toMatchObject({ phase: 'prepared' })
  })

  it('does not replace an external journal edit made after loading', async () => {
    const f = fixture(); await f.journal.load()
    fs.writeFileSync(f.file, '{review this changed recovery file')
    await expect(f.journal.prepare(f.intent)).rejects.toThrow('journal-changed')
    expect(fs.readFileSync(f.file, 'utf8')).toBe('{review this changed recovery file')
    expect(() => f.journal.list()).toThrow('unavailable')
  })

  it('retains known pending members after uncertain IO and reconstructs the durable recovered phase', async () => {
    let fail = false
    const f = fixture({ persist: async (file, data) => {
      await writeFileDurableAtomic(file, data, { mode: 0o600 })
      if (fail) throw new Error('acknowledgement lost')
    } })
    await f.journal.load(); const row = await f.journal.prepare(f.intent); await f.journal.markRemoved(row.id)
    fail = true
    await expect(f.journal.markRecovered(row.id)).rejects.toThrow('acknowledgement lost')
    expect(f.journal.isNodePending('group')).toBe(true)
    const reconstructed = new WorktreeRemovalJournal(f.file, { ownsFiles: () => true })
    await reconstructed.load()
    expect(reconstructed.isNodePending('group')).toBe(false)
    expect(reconstructed.blocks(f.intent.worktreePath)).toBe(true)
  })

  it('releases only a prepared kept-checkout record and retains other pending members', async () => {
    const f = fixture(); await f.journal.load(); const row = await f.journal.prepare(f.intent)
    const other = await f.journal.prepare({ ...f.intent, groupId: 'other', worktreePath: path.join(f.root, 'other-checkout'),
      members: [{ nodeId: 'other', binding: 'b'.repeat(64) }] })
    await f.journal.releaseKept(row.id, { verify: async () => {}, assertCurrent: () => {} })
    expect(f.journal.isNodePending('group')).toBe(false); expect(f.journal.blocks(f.intent.worktreePath)).toBe(false)
    expect(f.journal.isNodePending('other')).toBe(true)
    await f.journal.markRemoved(other.id)
    await expect(f.journal.releaseKept(other.id, { verify: async () => {}, assertCurrent: () => {} })).rejects.toThrow('recovery-required')
    expect(f.journal.isNodePending('other')).toBe(true)
  })

  it('never invents pending members from unreadable facts, while preserving known members after later corruption', async () => {
    const f = fixture(); await f.journal.load(); const row = await f.journal.prepare(f.intent)
    fs.writeFileSync(f.file, '{broken')
    await expect(f.journal.load()).rejects.toThrow()
    expect(f.journal.isNodePending(row.groupId)).toBe(true)
    const unknown = new WorktreeRemovalJournal(f.file, { ownsFiles: () => true })
    await expect(unknown.load()).rejects.toThrow()
    expect(unknown.isNodePending(row.groupId)).toBe(false)
    expect(() => unknown.reservedPaths()).toThrow('unavailable')
  })
})


it('retains private manual-start quarantine after durable repair and host reconstruction', async () => {
  const f = fixture(); await f.journal.load()
  const row = await f.journal.prepare(f.intent)
  await f.journal.markRemoved(row.id)
  await f.journal.planRepair(row.id, { members: [{ nodeId: 'group', binding: 'b'.repeat(64) }], manualStart: ['group'] }, () => {})
  await f.journal.markRecovered(row.id)
  expect(f.journal.isNodePending('group')).toBe(true)
  const restarted = new WorktreeRemovalJournal(f.file, f.config)
  expect(await restarted.load()).toMatchObject([{ phase: 'recovered', repair: { manualStart: ['group'] } }])
  expect(restarted.isNodePending('group')).toBe(true)
  await expect(restarted.releaseRebound(row.id)).rejects.toThrow('recovery-required')
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).version).toBe(5)
})

it.each([1, 2, 3])('reads historical version %s without inventing missing provenance and upgrades only on mutation', async (version) => {
  const f = fixture(); await f.journal.load(); const row = await f.journal.prepare(f.intent)
  const { provenance: _origin, ...legacy } = row
  const raw = JSON.stringify({ kind: 'worktree-removals', version, records: [version === 3 ? row : legacy] })
  fs.writeFileSync(f.file, raw)
  const fresh = new WorktreeRemovalJournal(f.file, f.config)
  expect(await fresh.load()).toMatchObject([{ directoryStamp: '1:2', provenance: { kind: 'recorded-directory' } }])
  expect(fs.readFileSync(f.file, 'utf8')).toBe(raw)
  await fresh.markRemoved(row.id)
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).version).toBe(5)
})
it('strictly distinguishes observed absence from recorded inode evidence and retains quarantine after lost first acknowledgement', async () => {
  const f = fixture({ persist: async (file, text) => { await writeFileDurableAtomic(file, text, { mode: 0o600 }); throw new Error('ack lost') } })
  await f.journal.load()
  const { directoryStamp: _stamp, ...intent } = f.intent
  const proposed = { ...intent, id: 'observed', createdAt: Date.now(), phase: 'removed' as const,
    provenance: { kind: 'observed-missing' as const, observedAt: Date.now(), ancestor: f.root, ancestorStamp: '1:2', repoStamp: '1:3', git: { gitDirectory: path.join(f.root, '.git'), commonDirectory: path.join(f.root, '.git'), fingerprint: 'a'.repeat(64) } } }
  expect(() => f.journal.observeMissing({ ...proposed, directoryStamp: '1:9' }, () => {})).toThrow('invalid-provenance')
  await expect(f.journal.observeMissing(proposed, () => {})).rejects.toThrow('ack lost')
  expect(f.journal.isNodePending('group')).toBe(true)
  const fresh = new WorktreeRemovalJournal(f.file, { ownsFiles: () => true }); await fresh.load()
  expect(fresh.list()[0]).not.toHaveProperty('directoryStamp')
  expect(fresh.list()[0].provenance.kind).toBe('observed-missing')
  await expect(fresh.releaseKept('observed', { verify: async () => {}, assertCurrent() {} })).rejects.toThrow('recovery-required')
  const oldVersion = JSON.parse(fs.readFileSync(f.file, 'utf8')); oldVersion.version = 2
  fs.writeFileSync(f.file, JSON.stringify(oldVersion))
  await expect(fresh.load()).rejects.toThrow('invalid-envelope')
})

it('retains v5 manual attempts and observations across reload, rejects downgrades and cannot erase an observed effect', async () => {
  const f = fixture(); await f.journal.load(); const row = await f.journal.prepare(f.intent)
  await f.journal.markRemoved(row.id)
  await f.journal.planRepair(row.id, { members: f.intent.members, manualStart: ['group'] }, () => {})
  await f.journal.markRecovered(row.id)
  const plan = { nodeId: 'group', nonce: '00000000-0000-4000-8000-000000000001', state: 'prepared' as const,
    cwd: f.intent.fallbackCwd, directoryStamp: '1:2', profile: 'a'.repeat(64), options: 'b'.repeat(64), members: f.intent.members }
  await f.journal.planManualResume(row.id, plan, () => {})
  await f.journal.markManualDispatch(row.id, plan.nonce, () => {})
  await f.journal.markManualObserved(row.id, plan.nonce, { backend: 'plain', pid: 123, birth: '456' })
  await expect(f.journal.markManualRefused(row.id, plan.nonce)).rejects.toThrow('invalid-transition')
  await expect(f.journal.markManualObserved(row.id, plan.nonce, { backend: 'plain', pid: 124, birth: '456' })).rejects.toThrow('evidence-changed')
  const bytes = fs.readFileSync(f.file, 'utf8'); const envelope = JSON.parse(bytes)
  expect(envelope.version).toBe(5)
  const restored = new WorktreeRemovalJournal(f.file, f.config); await restored.load()
  expect(restored.isNodePending('group')).toBe(true)
  for (const change of ['version', 'unknown', 'missing-proof', 'extra-proof', 'different-node']) {
    const bad = JSON.parse(bytes); const attempt = bad.records[0].manualResume[0]
    if (change === 'version') bad.version = 4
    if (change === 'unknown') attempt.releaseInput = true
    if (change === 'missing-proof') delete attempt.evidence
    if (change === 'extra-proof') attempt.evidence.allow = true
    if (change === 'different-node') attempt.nodeId = 'other'
    const text = JSON.stringify(bad); fs.writeFileSync(f.file, text)
    await expect(restored.load()).rejects.toThrow()
    expect(restored.isNodePending('group')).toBe(true)
    expect(fs.readFileSync(f.file, 'utf8')).toBe(text)
  }
  fs.writeFileSync(f.file, bytes); await restored.load()
  expect(restored.list()[0].manualResume).toMatchObject([{ state: 'observed', evidence: { pid: 123 } }])
})


it('checks prepared intent and recovered receipt guards inside the journal publication path', async () => {
  const f = fixture(); await f.journal.load()
  await expect(f.journal.prepare(f.intent, () => { throw new Error('owner departed') })).rejects.toThrow('owner departed')
  expect(fs.existsSync(f.file)).toBe(false)
  const row = await f.journal.prepare(f.intent); await f.journal.markRemoved(row.id)
  let calls = 0
  await expect(f.journal.markRecovered(row.id, () => { if (++calls > 1) throw new Error('receipt replaced') })).rejects.toThrow('receipt replaced')
  expect(calls).toBeGreaterThan(1)
  const disk = new WorktreeRemovalJournal(f.file, f.config)
  expect(await disk.load()).toMatchObject([{ phase: 'removed' }])
  expect(f.journal.isNodePending('group')).toBe(true)
})
