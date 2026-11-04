import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { transformSync } from 'esbuild'
import { commitCodexRolloutExposure, planCodexRolloutExposure } from '../../src/core/codex-accounts-core'
import { runCodexSwitch, runRemoteCodexSwitch, codexSwitchNotice } from '../../src/renderer/canvas/codex-switch-outcome'
import { runClaudeSwitch, switchOutcomeNotice, summarizeBulkSwitch } from '../../src/renderer/canvas/claude-account-switch'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })))
function exposure() {
  const root = mkdtempSync(path.join(tmpdir(), 'switch-outcome-')); roots.push(root)
  const source = path.join(root, 'source'); const target = path.join(root, 'target')
  mkdirSync(path.join(source, 'sessions'), { recursive: true }); mkdirSync(target)
  const file = path.join(source, 'sessions', 'rollout-thread.jsonl')
  writeFileSync(file, 'synthetic conversation\n')
  const plan = planCodexRolloutExposure(source, target, file, 'thread')
  return { publish: () => commitCodexRolloutExposure(plan), retained: () => {
    expect(readFileSync(plan.targetPath, 'utf8')).toBe('synthetic conversation\n')
    expect(statSync(plan.targetPath).ino).toBe(statSync(file).ino)
  } }
}
const fail = (): never => { throw new Error('lost boundary reply') }
function local(publish: () => void) {
  let reserved = false
  const deps = {
    prepare: vi.fn(async () => { reserved = true; return 'reservation' }),
    commit: vi.fn(async () => { publish() }),
    release: vi.fn(async () => { reserved = false }),
    finish: vi.fn(async () => { reserved = false }),
    eligible: () => true,
    requestMetadata: vi.fn(), restart: vi.fn(async () => 'restarted' as const)
  }
  return { deps, reserved: () => reserved }
}

describe('existing Codex choreography with real temporary exposure and lost boundary replies', () => {
  it.each(['commit', 'metadata', 'restart', 'finish'] as const)('retains actual publication after %s failure without replay or compensation', async (stage) => {
    const disk = exposure(); const f = local(disk.publish)
    if (stage === 'commit') f.deps.commit.mockImplementation(async () => { disk.publish(); fail() })
    if (stage === 'metadata') f.deps.requestMetadata.mockImplementation(fail)
    if (stage === 'restart') f.deps.restart.mockImplementation(async () => fail())
    if (stage === 'finish') f.deps.finish.mockImplementation(async () => fail())
    const facts = (await runCodexSwitch(f.deps))!
    disk.retained(); expect(f.reserved()).toBe(false)
    expect(f.deps.commit).toHaveBeenCalledTimes(1); expect(f.deps.release).toHaveBeenCalledTimes(1)
    expect(f.deps.restart).toHaveBeenCalledTimes(stage === 'restart' || stage === 'finish' ? 1 : 0)
    expect(facts.exposure).toBe(stage === 'commit' ? 'unconfirmed' : 'confirmed')
    expect(facts.metadataRequested).toBe(stage !== 'commit')
    expect(codexSwitchNotice(facts).text).not.toMatch(/rolled back|Nothing was changed|conversation resumed/i)
    expect(codexSwitchNotice(facts).kind).toBe('error')
    if (stage === 'finish') expect(codexSwitchNotice(facts).text).toContain('could not be confirmed as finished')
  })
  it('releases a stale prepared reservation before commit, without claiming preparation had no effects', async () => {
    const f = local(fail); f.deps.eligible = () => false
    const facts = (await runCodexSwitch(f.deps))!
    expect(f.reserved()).toBe(false); expect(f.deps.commit).not.toHaveBeenCalled()
    expect(f.deps.restart).not.toHaveBeenCalled(); expect(facts.stale).toBe(true)
    expect(codexSwitchNotice(facts).text).toContain('Sharing the conversation with the other account was not requested')
  })
  it('does not retry a failed release or negate pre-commit staleness', async () => {
    const f = local(fail); f.deps.eligible = () => false; f.deps.release.mockImplementation(async () => fail())
    const facts = (await runCodexSwitch(f.deps))!
    expect(f.deps.release).toHaveBeenCalledTimes(1); expect(facts.cleanupFailed).toBe(true)
    expect(f.deps.commit).not.toHaveBeenCalled()
  })
  it('reports preparation failure without claiming no daemon effects', async () => {
    const f = local(fail); f.deps.prepare.mockImplementation(async () => fail())
    const facts = (await runCodexSwitch(f.deps))!
    expect(codexSwitchNotice(facts).text).toContain('could not be prepared')
    expect(f.deps.commit).not.toHaveBeenCalled(); expect(f.deps.release).not.toHaveBeenCalled()
  })
  it('preserves normal order and describes renderer completion without verified resume', async () => {
    const disk = exposure(); const f = local(disk.publish)
    const facts = (await runCodexSwitch(f.deps))!
    disk.retained(); expect(f.reserved()).toBe(false); expect(f.deps.release).not.toHaveBeenCalled()
    expect(f.deps.prepare.mock.invocationCallOrder[0]).toBeLessThan(f.deps.commit.mock.invocationCallOrder[0])
    expect(f.deps.commit.mock.invocationCallOrder[0]).toBeLessThan(f.deps.requestMetadata.mock.invocationCallOrder[0])
    expect(f.deps.requestMetadata.mock.invocationCallOrder[0]).toBeLessThan(f.deps.restart.mock.invocationCallOrder[0])
    expect(f.deps.restart.mock.invocationCallOrder[0]).toBeLessThan(f.deps.finish.mock.invocationCallOrder[0])
    expect(codexSwitchNotice(facts).text).toContain('Check that the terminal has resumed the right conversation')
  })
  it.each(['lost', 'stale', 'restart'] as const)('remote %s keeps published exposure distinct from pane result', async (stage) => {
    const disk = exposure()
    const restart = vi.fn(async (binding: () => void) => { binding(); fail(); return 'restarted' as const })
    const facts = await runRemoteCodexSwitch({
      expose: async () => { disk.publish(); if (stage === 'lost') fail() },
      eligible: () => stage !== 'stale', restart, markDirty: vi.fn()
    })
    disk.retained(); expect(facts.exposure).toBe(stage === 'lost' ? 'unconfirmed' : 'confirmed')
    expect(restart).toHaveBeenCalledTimes(stage === 'restart' ? 1 : 0)
    expect(facts.metadataRequested).toBe(stage === 'restart')
  })
})

describe('Claude single and bulk outcomes', () => {
  it('retains acknowledged copy after recycle throws, in single and bulk notices', async () => {
    const copy = vi.fn(async () => ({ ok: true as const, copied: true }))
    const result = await runClaudeSwitch({ copy, targetAccountId: 'target', markDirty: vi.fn(),
      restart: async (before) => { expect(await before()).toEqual({ accountId: 'target' }); fail(); return 'restarted' }
    })
    expect(copy).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ kind: 'not-restarted', copy: 'confirmed' })
    expect(switchOutcomeNotice(result, 'Target')?.text).toContain('copy remains available')
    expect(summarizeBulkSwitch([result], 0, 'Target').text).toContain('1 copy available, restart incomplete')
  })
  it('does not assert original-account resume after a partial copy failure', async () => {
    const result = await runClaudeSwitch({ copy: async () => fail(), targetAccountId: 'target', markDirty: vi.fn(),
      restart: async (before) => { expect(await before()).toBeUndefined(); return 'restarted' }
    })
    expect(result.kind).toBe('copy-failed')
    expect(switchOutcomeNotice(result, 'Target')?.text).toContain('partial copy may remain')
    expect(summarizeBulkSwitch([result], 0, 'Target').text).toContain('copy unconfirmed')
    expect(switchOutcomeNotice(result, 'Target')?.text).not.toContain('resumed on its current account')
  })
  it('separates pre-copy restart refusal from a dispatched copy', async () => {
    const copy = vi.fn(async () => ({ ok: true as const, copied: true }))
    const result = await runClaudeSwitch({ copy, targetAccountId: 'target', markDirty: vi.fn(), restart: async () => 'not-eligible' })
    expect(copy).not.toHaveBeenCalled(); expect(result).toMatchObject({ copy: 'not-requested' })
  })
})

// Execute the shipped Canvas callbacks, not just text pins or a duplicate orchestration model.
function canvasCallback(name: string, next: string, deps: Record<string, unknown>) {
  const source = readFileSync(path.resolve(__dirname, '../../src/renderer/canvas/Canvas.tsx'), 'utf8')
  const body = source.slice(source.indexOf(`  const ${name} = useCallback(`), source.indexOf(next, source.indexOf(`  const ${name} = useCallback(`)))
  const js = transformSync(body + `\nreturn ${name}`, { loader: 'tsx', target: 'es2022' }).code
  return new Function(...Object.keys(deps), js)(...Object.values(deps))
}
it.each([false, true])('Canvas wires actual Codex effect tracking (remote=%s)', async (remote) => {
  const disk = exposure(); const f = local(disk.publish); const notices: Array<{ text: string }> = []
  const fn = vi.fn(async () => fail())
  const codexAccounts = {
    switchThread: async () => ({ rollbackToken: await f.deps.prepare() }),
    commitSwitch: async () => { disk.publish(); fail() }, rollbackSwitch: f.deps.release, finishSwitch: f.deps.finish,
    switchThreadRemote: async () => { disk.publish(); fail() }
  }
  const run = canvasCallback('switchCodexAccountNode', '\n  // "Switch Claude account"', {
    useCallback: (f: unknown) => f, window: { nodeTerminal: { codexAccounts } },
    nodesRef: { current: [{ id: 'node', type: 'terminal', data: { agentId: 'codex', cwd: '/fixture', ssh: remote ? {} : undefined } }] },
    useAgentStatus: { getState: () => ({ byId: { node: { sessionId: 'thread', state: 'idle' } } }) },
    restartSessionId: () => 'thread', sshHostKey: () => 'host',
    planCodexAccountSwitch: () => ({ ok: true, plan: { sessionId: 'thread', targetAccountId: 'target', expected: {} } }),
    codexAccountSwitchStillEligible: () => true,
    useSettings: { getState: () => ({ settings: { codexAccounts: [] } }) },
    useProjects: { getState: () => ({ activeProjectId: 'project', getProject: () => undefined }) },
    useSshConn: { getState: () => ({ byProject: {} }) }, connectedProjectIdForHost: () => 'project',
    setNotice: (n: { text: string }) => notices.push(n), setNodes: vi.fn(), markDirty: vi.fn(),
    usePendingPause: { getState: () => ({ remove: vi.fn() }) }, agentRestartFn: () => fn,
    settleRestart: async (f: () => Promise<unknown>) => { try { return await f() } catch { return 'exit-timeout' } },
    runCodexSwitch, runRemoteCodexSwitch, codexSwitchNotice
  })
  await run('node', 'target'); disk.retained()
  expect(notices[0].text).toContain('conversation may already be available')
  expect(notices[0].text).not.toMatch(/Nothing was changed|rolled back|conversation resumed/i)
})

it('Canvas retains Claude copy acknowledgement after actual restart callback failure', async () => {
  const copy = vi.fn(async () => ({ ok: true as const, copied: true }))
  const markDirty = vi.fn()
  const run = canvasCallback('runClaudeAccountSwitch', '\n  const switchClaudeAccountNode', {
    useCallback: (f: unknown) => f, window: { nodeTerminal: { claudeAccounts: { copySession: copy } } },
    nodesRef: { current: [{ id: 'node', data: {} }] },
    useAgentStatus: { getState: () => ({ byId: { node: {} } }) },
    useSettings: { getState: () => ({ settings: { claudeAccounts: [] } }) },
    restartAgentIdOf: () => 'claude', effectiveAccountId: () => 'source', claudeSwitchHostKey: () => undefined,
    session: { source: 'local' }, isRemoteSessionNode: () => false, restartSessionId: () => 'session',
    planClaudeAccountSwitch: () => ({ ok: true, plan: { sessionId: 'session', sourceAccountId: 'source', targetAccountId: 'target' } }),
    usePendingPause: { getState: () => ({ remove: vi.fn() }) },
    agentRestartFn: () => async (_a: unknown, _b: unknown, _c: unknown, _d: unknown, before: () => Promise<unknown>) => {
      expect(await before()).toEqual({ accountId: 'target' }); fail()
    },
    runClaudeSwitch, markDirty, connectedProjectIdForHost: vi.fn()
  })
  const result = await run('node', 'target')
  expect(result).toMatchObject({ kind: 'not-restarted', copy: 'confirmed' })
  expect(copy).toHaveBeenCalledTimes(1); expect(markDirty).toHaveBeenCalledTimes(1)
})

it('keeps Claude copy and restart facts when requesting persistence throws', async () => {
  const result = await runClaudeSwitch({
    copy: async () => ({ ok: true, copied: true }), targetAccountId: 'target', markDirty: fail,
    restart: async (before) => { await before(); return 'restarted' }
  })
  expect(result).toEqual({ kind: 'switched', saveUnconfirmed: true })
  expect(switchOutcomeNotice(result, 'Target')).toMatchObject({ kind: 'error' })
  expect(switchOutcomeNotice(result, 'Target')?.text).toContain('Saving the account selection was not confirmed')
  expect(summarizeBulkSwitch([result], 0, 'Target').text).toContain('1 account saves unconfirmed')
})
