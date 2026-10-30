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
    expect((fs.statSync(f.file).mode & 0o777)).toBe(0o600)
    const resumed = new WorktreeRemovalJournal(f.file, f.config)
    expect(await resumed.load()).toEqual([prepared])
    await expect(resumed.markRecovered(prepared.id)).rejects.toThrow('invalid-transition')
    await resumed.markRemoved(prepared.id)
    await resumed.markRecovered(prepared.id)
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
      if (issue === 'unknown version') envelope.version = 2
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
      await expect(f.journal.prepare({ ...f.intent, ...bad })).rejects.toThrow('invalid-record')
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
})
