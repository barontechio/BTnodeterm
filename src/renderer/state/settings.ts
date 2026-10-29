import { create } from 'zustand'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import { SettingsWriteQueue } from '../lib/settingsWriteQueue'

interface SettingsState {
  settings: Settings
  /** True once settings have been loaded from disk (so first-run logic can wait). */
  hydrated: boolean
  hydrate(): Promise<void>
  update(patch: Partial<Settings>): void
  /** Publish current settings before an operation whose core-side decision depends on them. */
  flush(): Promise<void>
}

const writes = new SettingsWriteQueue({
  api: () => window.nodeTerminal.settings,
  current: () => useSettings.getState().settings,
  apply: (settings) => useSettings.setState({ settings: { ...DEFAULT_SETTINGS, ...settings } }),
  failed: () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nodeterm:toast', {
      detail: { kind: 'error', text: 'Settings save was not confirmed. Check the values after reconnecting.' }
    }))
  }
})

/** Owner-only host pushes merge with explicit pending UI edits, never a full stale snapshot. */
export function listenHostSettings(): () => void {
  return window.nodeTerminal.settings.onChanged?.((settings) => writes.receive(settings)) ?? (() => {})
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => { void writes.flushPending().catch(() => {}) })
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,

  async flush() {
    await writes.flush()
  },

  async hydrate() {
    const s = await window.nodeTerminal.settings.load()
    set({ settings: { ...DEFAULT_SETTINGS, ...s }, hydrated: true })
  },

  update(patch) {
    const requested = { ...patch }
    const next = { ...get().settings, ...patch }
    // `vanillaLaunchDefault` is the one-release downgrade mirror for `agentLaunchMode`: an older
    // build reads the boolean, so when the user picks a mode here the mirror must follow. (The
    // read path in core settings-store keeps them in lockstep on load; this keeps them in lockstep
    // on write.) `'subscription'` ⇒ true (strip env), anything else ⇒ false.
    if ('agentLaunchMode' in patch) {
      next.vanillaLaunchDefault = patch.agentLaunchMode === 'subscription'
      requested.vanillaLaunchDefault = next.vanillaLaunchDefault
    }
    set({ settings: next })
    if (typeof window !== 'undefined') writes.schedule(next, requested)
  }
}))
