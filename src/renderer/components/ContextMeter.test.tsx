// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { ContextMeter } from './ContextMeter'
import { useContextWindow } from '../state/contextWindow'
import { useSettings } from '../state/settings'
import { setCustomAgentBaseResolver } from '@shared/agents/config'

it('qualifies model-name guesses but not observed session configuration', async () => {
  const el = document.createElement('div')
  const root = createRoot(el)
  const usage = { sessionId: 's', usedTokens: 16000, windowTokens: 32000, usedPercent: 50, model: 'vendor-sonnet', updatedAt: Date.now() }
  try {
    useContextWindow.getState().set({ ...usage, windowSource: 'estimate' })
    await act(async () => root.render(<ContextMeter sessionId="s" />))
    expect(el.querySelector('button')?.title).toContain('Estimated context window')
    await act(async () => { useContextWindow.getState().set({ ...usage, windowSource: 'session-env' }) })
    expect(el.querySelector('button')?.title).toMatch(/^Context window/)
  } finally { await act(async () => root.unmount()) }
})

it('shows only the requested SSH node even when local and remote rollouts share an id', async () => {
  useSettings.setState(s => ({ settings: { ...s.settings, usagePercentMode: 'used' } }))
  const el = document.createElement('div')
  const root = createRoot(el)
  const usage = { sessionId: 'copied', usedTokens: 10, windowTokens: 100, usedPercent: 10, model: 'gpt', updatedAt: Date.now(), windowSource: 'transcript' as const }
  useContextWindow.setState({ bySessionId: {}, byNodeId: {} })
  useContextWindow.getState().set(usage)
  useContextWindow.getState().set({ ...usage, nodeId: 'a', usedPercent: 70 })
  try {
    await act(async () => root.render(<ContextMeter sessionId="copied" nodeId="b" remote agentId="codex" />))
    expect(el.querySelector('button')).toBeNull()
    await act(async () => root.render(<ContextMeter sessionId="copied" nodeId="a" remote agentId="codex" />))
    expect(el.querySelector('button')?.title).toContain('70%')
    setCustomAgentBaseResolver(id => id === 'custom:remote-codex' ? 'codex' : undefined)
    await act(async () => root.render(<ContextMeter sessionId="copied" nodeId="b" remote agentId="custom:remote-codex" />))
    expect(el.querySelector('button')).toBeNull()
    await act(async () => root.render(<ContextMeter sessionId="new-thread" nodeId="a" remote agentId="codex" />))
    expect(el.querySelector('button')).toBeNull()
    await act(async () => root.render(<ContextMeter sessionId="copied" />))
    expect(el.querySelector('button')?.title).toContain('10%')
  } finally {
    setCustomAgentBaseResolver(null)
    await act(async () => root.unmount())
  }
})

// Issue #1141: "Model & context meter" in Settings → Appearance → Terminal header buttons hides
// the pill everywhere this component renders (node header, kanban card, card modal).
it('renders nothing when the context meter is hidden in Appearance', async () => {
  const el = document.createElement('div')
  const root = createRoot(el)
  const usage = { sessionId: 'h', usedTokens: 10, windowTokens: 100, usedPercent: 10, model: 'm', updatedAt: Date.now(), windowSource: 'transcript' as const }
  useContextWindow.getState().set(usage)
  try {
    useSettings.setState(s => ({ settings: { ...s.settings, hiddenHeaderButtons: [] } }))
    await act(async () => root.render(<ContextMeter sessionId="h" />))
    expect(el.querySelector('button')).not.toBeNull()
    await act(async () => { useSettings.setState(s => ({ settings: { ...s.settings, hiddenHeaderButtons: ['context-meter'] } })) })
    expect(el.querySelector('.ctx-meter')).toBeNull()
  } finally {
    useSettings.setState(s => ({ settings: { ...s.settings, hiddenHeaderButtons: [] } }))
    await act(async () => root.unmount())
  }
})

it('uses node-scoped Server Claude observations and clears without falling back to local history', async () => {
  const { SessionContext } = await import('../session/session')
  const session = { api: { context: { watchRemote: () => () => {} } } } as unknown as import('../session/session').WorkspaceSession
  useSettings.setState(s => ({ settings: { ...s.settings, hiddenHeaderButtons: [], usagePercentMode: 'used' } }))
  useContextWindow.setState({ bySessionId: {}, byNodeId: {} })
  const usage = { sessionId: 'claude-copy', usedTokens: 10, windowTokens: 100, usedPercent: 10, model: 'claude', updatedAt: Date.now() }
  useContextWindow.getState().set(usage)
  useContextWindow.getState().set({ ...usage, nodeId: 'remote', usedPercent: 60 })
  const el = document.createElement('div'), root = createRoot(el)
  try {
    await act(async () => root.render(<SessionContext.Provider value={session}>
      <ContextMeter sessionId="claude-copy" nodeId="remote" remote agentId="claude" />
    </SessionContext.Provider>))
    expect(el.querySelector('button')?.title).toContain('60%')
    await act(async () => useContextWindow.getState().set({ ...usage, nodeId: 'remote', cleared: true }))
    expect(el.querySelector('button')).toBeNull()
    // Desktop has no owner demand API and retains its existing session-scoped Claude meter.
    await act(async () => root.render(<ContextMeter sessionId="claude-copy" nodeId="remote" remote agentId="claude" />))
    expect(el.querySelector('button')?.title).toContain('10%')
  } finally { await act(async () => root.unmount()) }
})
