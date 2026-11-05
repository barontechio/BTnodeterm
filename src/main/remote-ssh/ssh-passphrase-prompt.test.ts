// The main→renderer half of the passphrase prompt (ssh-project.ts): deliver the request, wait
// for the renderer's submit, expire abandoned prompts, and fail fast when no UI can hear it.
// None of this needs Electron: main-window.ts takes any MainWindowLike via setMainWindow, and
// resolvePassphrasePrompt is exactly what the ipcMain.handle(sshPassphraseSubmit) delegates to.
// Before these tests, a swapped (requestId, value) argument or a renamed channel was green
// everywhere except a live app.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { promptForPassphrase, resolvePassphrasePrompt, forgetSshPassphraseOwner } from './ssh-project'
import { setMainWindow, type MainWindowLike } from '../main-window'
import { IPC } from '../../shared/ipc'
import type { SshPassphraseRequest } from '../../shared/types'

/** Everything promptForPassphrase pushed at the (fake) renderer, in order. */
type Sent = { channel: string; payload: Record<string, unknown> }

function installWindow(opts?: { destroyed?: boolean; sendThrows?: boolean }): Sent[] {
  const sent: Sent[] = []
  const win: MainWindowLike = {
    isDestroyed: () => opts?.destroyed ?? false,
    isFocused: () => true,
    isMinimized: () => false,
    restore: () => {},
    show: () => {},
    focus: () => {},
    on: () => {},
    webContents: {
      id: 42,
      send: (channel: string, ...args: unknown[]) => {
        // Mirrors the real failure mode: webContents.send throws "Render frame was disposed"
        // while the window object itself still looks alive.
        if (opts?.sendThrows) throw new Error('Render frame was disposed')
        sent.push({ channel, payload: args[0] as Record<string, unknown> })
      }
    }
  }
  setMainWindow(win)
  return sent
}

afterEach(() => {
  vi.useRealTimers()
  // Leave no live fake window behind for other tests in this file.
  installWindow({ destroyed: true })
})

describe('promptForPassphrase / resolvePassphrasePrompt', () => {
  it('delivers the request on the right channel and resolves with the submitted value', async () => {
    const sent = installWindow()
    const p = promptForPassphrase({ identityFile: '/home/u/.ssh/id_ed25519', retry: true, target: 'u@h1' })
    expect(sent).toHaveLength(1)
    expect(sent[0].channel).toBe(IPC.sshPassphraseRequest)
    const req = sent[0].payload as unknown as SshPassphraseRequest
    expect(req.identityFile).toBe('/home/u/.ssh/id_ed25519')
    expect(req.retry).toBe(true)
    expect(req.requestId).toBeTruthy()
    // One key can serve several servers and this prompt can fire from the watchdog, so the dialog
    // has to be able to name the destination it is unlocking for.
    expect(req.target).toBe('u@h1')
    // The (requestId, value) order is the load-bearing contract with the renderer's submit.
    resolvePassphrasePrompt(req.requestId, 'hunter2')
    await expect(p).resolves.toBe('hunter2')
  })

  it('a null submit (the Cancel button) resolves null, i.e. an ACTIVE decline', async () => {
    const sent = installWindow()
    const p = promptForPassphrase({ identityFile: '/k', retry: false })
    const req = sent[0].payload as unknown as SshPassphraseRequest
    resolvePassphrasePrompt(req.requestId, null)
    await expect(p).resolves.toBeNull()
  })

  it('expires an abandoned prompt as undefined (never "cancelled") and dismisses the dialog', async () => {
    vi.useFakeTimers()
    const sent = installWindow()
    const p = promptForPassphrase({ identityFile: '/k', retry: false })
    const req = sent[0].payload as unknown as SshPassphraseRequest
    await vi.advanceTimersByTimeAsync(301_000) // just past the 5-minute prompt expiry
    // undefined = nobody answered; only an explicit null may be reported as a cancellation.
    await expect(p).resolves.toBeUndefined()
    // The renderer's (possibly still open) dialog is closed so a late answer has nowhere to land.
    const dismiss = sent.find((s) => s.channel === IPC.sshPassphraseDismiss)
    expect(dismiss?.payload).toEqual({ requestId: req.requestId })
    // A late submit against the expired request is a silent no-op, not a crash.
    expect(() => resolvePassphrasePrompt(req.requestId, 'too-late')).not.toThrow()
  })

  it('resolves undefined immediately when no window exists (nobody could ever answer)', async () => {
    installWindow({ destroyed: true })
    // Must not ride the 5-minute expiry: with the window closed (macOS close-to-dock) the
    // watchdog would otherwise hold every reconnect's master for the full window, repeatedly.
    await expect(promptForPassphrase({ identityFile: '/k', retry: false })).resolves.toBeUndefined()
  })

  it('resolves undefined immediately when the send throws (frame disposed mid-reload)', async () => {
    installWindow({ sendThrows: true })
    await expect(promptForPassphrase({ identityFile: '/k', retry: false })).resolves.toBeUndefined()
  })

  it('a double submit resolves once and the second is a no-op', async () => {
    const sent = installWindow()
    const p = promptForPassphrase({ identityFile: '/k', retry: false })
    const req = sent[0].payload as unknown as SshPassphraseRequest
    resolvePassphrasePrompt(req.requestId, 'first')
    resolvePassphrasePrompt(req.requestId, 'second')
    await expect(p).resolves.toBe('first')
  })

  it('concurrent prompts resolve independently by requestId', async () => {
    const sent = installWindow()
    const a = promptForPassphrase({ identityFile: '/ka', retry: false })
    const b = promptForPassphrase({ identityFile: '/kb', retry: false })
    const [reqA, reqB] = sent.map((s) => s.payload as unknown as SshPassphraseRequest)
    expect(reqA.requestId).not.toBe(reqB.requestId)
    // Answer them out of order: each answer must land on ITS request, not the newest one.
    resolvePassphrasePrompt(reqB.requestId, 'for-b')
    resolvePassphrasePrompt(reqA.requestId, 'for-a')
    await expect(a).resolves.toBe('for-a')
    await expect(b).resolves.toBe('for-b')
  })

  it('cancels a departed document and never transfers its request to a reloaded document', async () => {
    const sent = installWindow()
    const old = promptForPassphrase({ identityFile: '/key', retry: false })
    const oldRequest = sent[0].payload as unknown as SshPassphraseRequest
    forgetSshPassphraseOwner(42)
    expect(await old).toBeUndefined()
    const current = promptForPassphrase({ identityFile: '/key', retry: false })
    const request = sent.filter((message) => message.channel === IPC.sshPassphraseRequest).at(-1)!.payload as unknown as SshPassphraseRequest
    resolvePassphrasePrompt(oldRequest.requestId, 'stale')
    resolvePassphrasePrompt(request.requestId, 'current')
    expect(await current).toBe('current')
  })
})
