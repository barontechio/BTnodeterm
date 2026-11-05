import { readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { platform } from './platform'

// Stable anonymous machine id, persisted in userData (shared with telemetry).
export function getDeviceId(): string {
  const file = path.join(platform().userDataDir, 'device-id')
  try {
    const existing = readFileSync(file, 'utf-8').trim()
    if (existing) return existing
  } catch {
    // not created yet
  }
  const id = randomUUID()
  // The synchronous API must publish before another feature can ask for the identity. An
  // asynchronous replace could mint two device-bound licenses under different ids at boot.
  try {
    writeFileSync(file, id, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    return id
  } catch (error) {
    // Another process won creation; its persisted identity is authoritative.
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const existing = readFileSync(file, 'utf8').trim()
      if (existing) return existing
      throw new Error('device identity file is empty')
    }
    throw error
  }
}
