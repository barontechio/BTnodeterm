import { afterEach, describe, expect, it, vi } from 'vitest'
import { browserRemoteUpload, RemoteUploadUncertainError, remoteTransferReference } from './remote-transfers'
import type { RemoteTransfersApi } from '@shared/remote-transfers'
vi.mock('../state/projects', () => ({useProjects: {getState: () => ({projects: []})}}))
vi.mock('../state/sshConn', () => ({useSshConn: {getState: () => ({byProject: {}})}}))
afterEach(() => vi.unstubAllGlobals())
const ref = 'a'.repeat(32)
const api = (status: unknown) => ({prepare: vi.fn(async () => ({status: 'ready', reference: ref,
  url: '/ssh-transfer?ref=' + ref, bytes: 4, expiresAt: Date.now() + 1000})),
  status: vi.fn(async () => status), release: vi.fn(async () => {}), renew: vi.fn()} as unknown as RemoteTransfersApi)
describe('browser SSH upload uncertainty', () => {
  it('recovers a lost acknowledgement by receipt without replaying the body', async () => {
    const fetch = vi.fn(async () => {throw new Error('connection closed')}); vi.stubGlobal('fetch', fetch)
    const service = api({outcome: 'committed', path: '/remote/file', bytes: 4, sha256: 'a'.repeat(64)})
    expect(await browserRemoteUpload(service, 'project', 'node', new File(['body'], 'name'))).toBe('/remote/file')
    expect(fetch).toHaveBeenCalledTimes(1); expect(service.status).toHaveBeenCalledOnce()
    expect(service.release).toHaveBeenCalledWith(ref)
  })
  it('keeps unknown visible and never retries malformed replies as an upload', async () => {
    const fetch = vi.fn(async () => ({json: async () => null})); vi.stubGlobal('fetch', fetch)
    const service = api({outcome: 'unknown'})
    await expect(browserRemoteUpload(service, 'project', 'node', new File(['body'], 'name'))).rejects.toBeInstanceOf(RemoteUploadUncertainError)
    expect(fetch).toHaveBeenCalledOnce(); expect(service.release).not.toHaveBeenCalled()
    expect(new RemoteUploadUncertainError().message).toContain('even if that folder was moved')
  })
  it('accepts only a relative host transfer route', () => {
    expect(remoteTransferReference('/ssh-transfer?ref=' + ref)).toBe(ref)
    expect(remoteTransferReference('https://other/ssh-transfer?ref=' + ref)).toBeNull()
    expect(remoteTransferReference('//other/ssh-transfer?ref=' + ref)).toBeNull()
  })
})
