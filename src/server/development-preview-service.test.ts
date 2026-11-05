import { describe, expect, it, vi } from 'vitest'
import type { WorkspaceStore } from '../core/workspace-store'
import type { PtyManager } from '../core/pty-manager'
import { fakePlatform } from '../core/platform-fake'
import { registerDevelopmentPreviewService } from './development-preview-service'
import { IPC } from '../shared/ipc'
import { HOST_ONLY_CHANNEL_PREFIXES } from '../shared/host-control'
import { DevelopmentPreviews } from '../core/development-previews'
import { resolveConfig } from './config'

it('disabled composition starts no discovery, workspace read or transport', async () => {
  const platform = fakePlatform({ isOwnerClient: id => id === 1 })
  const load = vi.fn(), getTmuxBin = vi.fn()
  const service = registerDevelopmentPreviewService({ platform, workspace: { load } as unknown as WorkspaceStore,
    pty: { getTmuxBin } as unknown as PtyManager, managementPorts: () => [] })
  try {
    expect(service.transport).toBeUndefined()
    expect(await platform.handlers[IPC.developmentPreviewStatus](1)).toMatchObject({ supported: false, storage: 'disabled' })
    expect(() => platform.handlers[IPC.developmentPreviewList](1, { projectId: 'p', nodeId: 'n' })).toThrow('unsupported')
    expect(load).not.toHaveBeenCalled(); expect(getTmuxBin).not.toHaveBeenCalled()
    for (const channel of [IPC.developmentPreviewStatus, IPC.developmentPreviewList, IPC.developmentPreviewOpen, IPC.developmentPreviewStop]) {
      expect(() => platform.handlers[channel](2, 'forged')).toThrow('owner-required')
      expect(HOST_ONLY_CHANNEL_PREFIXES.some(prefix => channel.startsWith(prefix))).toBe(true)
    }
  } finally { service.stop() }
})

describe('development preview origin and operator configuration policy', () => {
  it.each([
    ['https://preview.example.com', 'https://app.example.com'],
    ['https://preview.example.co.uk', 'https://app.example.co.uk'],
    ['https://preview.foo.github.io', 'https://app.foo.github.io'],
    ['https://co.uk', 'https://app.example.com'],
    ['https://preview.invalid-tld', 'https://app.example.com']
  ])('refuses shared/unknown registrable domain %s', (base, app) => {
    expect(() => new DevelopmentPreviews(base, app, { resolve: async () => null })).toThrow()
  })
  it('permits independently isolated public and private suffix sites', () => {
    for (const [base, app] of [['https://preview.example.net', 'https://app.example.com'], ['https://preview.foo.github.io', 'https://app.bar.github.io']]) {
      const previews = new DevelopmentPreviews(base, app, { resolve: async () => null })
      previews.stop()
    }
  })
  it('requires both operator origin and approved records', () => {
    expect(() => resolveConfig({ NODETERM_DEV_PREVIEW_ORIGIN: 'https://preview.example.net' }, [])).toThrow()
    const config = resolveConfig({ NODETERM_PUBLIC_ORIGIN: 'https://app.example.com', NODETERM_DEV_PREVIEW_ORIGIN: 'https://preview.example.net',
      NODETERM_DEV_PREVIEW_TARGETS: JSON.stringify([{ projectId: 'p', nodeId: 'n', port: 3000, argv: ['node', 'vite.js'] }]) }, [])
    expect(config.developmentPreviews?.approved[0].port).toBe(3000)
  })
})
