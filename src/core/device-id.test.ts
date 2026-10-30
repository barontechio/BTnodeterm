import fs from 'node:fs'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { getDeviceId } from './device-id'

afterEach(() => { vi.restoreAllMocks(); resetPlatformForTests() })
it('publishes a private device identity before returning and preserves it across immediate callers', () => {
  const platform = fakePlatform(); initPlatform(platform)
  const asynchronous = vi.spyOn(fs.promises, 'writeFile').mockRejectedValue(new Error('asynchronous identity persistence is not durable on return'))
  const first = getDeviceId()
  expect(fs.readFileSync(path.join(platform.userDataDir, 'device-id'), 'utf8')).toBe(first)
  expect(getDeviceId()).toBe(first)
  expect(asynchronous).not.toHaveBeenCalled()
  if (process.platform !== 'win32') expect(fs.statSync(path.join(platform.userDataDir, 'device-id')).mode & 0o777).toBe(0o600)
})
it('keeps an existing installation identity unchanged', () => {
  const platform = fakePlatform(); initPlatform(platform)
  const file = path.join(platform.userDataDir, 'device-id'); fs.writeFileSync(file, 'existing-device\n')
  expect(getDeviceId()).toBe('existing-device')
  expect(fs.readFileSync(file, 'utf8')).toBe('existing-device\n')
})
