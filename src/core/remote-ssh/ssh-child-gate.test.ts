import { describe, it, expect } from 'vitest'
import {
  SshChildGate,
  controlPathOf,
  isMuxControlCommand,
  SSH_CHILD_CONCURRENCY
} from './ssh-child-gate'
import { childArgs, checkMasterArgs, exitMasterArgs, hookForwardArgs } from './control-master'
import type { SshConnection } from '../../shared/ssh'

const conn: SshConnection = { user: 'deploy', host: 'h.example.com' }

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('controlPathOf', () => {
  it('reads the path out of the argv our own builders emit', () => {
    expect(controlPathOf(childArgs(conn, '/cm/p1.sock', 'true'))).toBe('/cm/p1.sock')
    expect(controlPathOf(checkMasterArgs(conn, '/cm/p1.sock'))).toBe('/cm/p1.sock')
  })

  it('accepts the single-token spelling ssh also accepts', () => {
    expect(controlPathOf(['-oControlPath=/cm/x.sock', 'h'])).toBe('/cm/x.sock')
  })

  it('is undefined when no control path is named', () => {
    expect(controlPathOf(['-G', 'deploy@h.example.com'])).toBeUndefined()
  })

  it('does not mistake another ControlPath-suffixed option for the path', () => {
    expect(controlPathOf(['-o', 'ControlPersist=300', '-o', 'ControlMaster=auto'])).toBeUndefined()
  })
})

describe('isMuxControlCommand', () => {
  it('recognises every -O command we build', () => {
    expect(isMuxControlCommand(checkMasterArgs(conn, '/cm/p.sock'))).toBe(true)
    expect(isMuxControlCommand(exitMasterArgs(conn, '/cm/p.sock'))).toBe(true)
    expect(isMuxControlCommand(hookForwardArgs(conn, '/cm/p.sock', '/tmp/s.sock', 1234))).toBe(true)
  })

  it('an ordinary exec child is not one', () => {
    expect(isMuxControlCommand(childArgs(conn, '/cm/p.sock', 'printf ok'))).toBe(false)
  })
})

describe('SshChildGate', () => {
  it('never runs more than the limit at once for one control path', async () => {
    const gate = new SshChildGate(3)
    const args = childArgs(conn, '/cm/p1.sock', 'true')
    let live = 0
    let peak = 0
    const gates = Array.from({ length: 8 }, () => deferred())

    const runs = gates.map((g) =>
      gate.run(args, async () => {
        live++
        peak = Math.max(peak, live)
        await g.promise
        live--
      })
    )

    await Promise.resolve()
    expect(peak).toBe(3)
    // Release them one at a time; the queue must refill but never overshoot.
    for (const g of gates) {
      g.resolve()
      await Promise.resolve()
      await Promise.resolve()
    }
    await Promise.all(runs)
    expect(peak).toBe(3)
    expect(gate.inFlight('/cm/p1.sock')).toBe(0)
    expect(gate.queued('/cm/p1.sock')).toBe(0)
  })

  it('budgets are per control path — one busy host never throttles another', async () => {
    const gate = new SshChildGate(1)
    const a = deferred()
    const b = deferred()
    let startedB = false

    void gate.run(childArgs(conn, '/cm/a.sock', 'true'), () => a.promise)
    const runB = gate.run(childArgs(conn, '/cm/b.sock', 'true'), async () => {
      startedB = true
      await b.promise
    })

    await Promise.resolve()
    expect(startedB).toBe(true)
    b.resolve()
    a.resolve()
    await runB
  })

  it('mux control commands bypass the queue entirely', async () => {
    const gate = new SshChildGate(1)
    const held = deferred()
    void gate.run(childArgs(conn, '/cm/p1.sock', 'true'), () => held.promise)
    await Promise.resolve()

    // The watchdog's health probe must not wait behind a 5 MB transcript read.
    let checked = false
    await gate.run(checkMasterArgs(conn, '/cm/p1.sock'), async () => {
      checked = true
    })
    expect(checked).toBe(true)
    held.resolve()
  })

  it('releases the slot when the work throws', async () => {
    const gate = new SshChildGate(1)
    const args = childArgs(conn, '/cm/p1.sock', 'true')
    await expect(
      gate.run(args, async () => {
        throw new Error('spawn failed')
      })
    ).rejects.toThrow('spawn failed')
    expect(gate.inFlight('/cm/p1.sock')).toBe(0)

    let ran = false
    await gate.run(args, async () => {
      ran = true
    })
    expect(ran).toBe(true)
  })

  it('runs FIFO, so a queued read cannot be starved by later arrivals', async () => {
    const gate = new SshChildGate(1)
    const args = childArgs(conn, '/cm/p1.sock', 'true')
    const order: number[] = []
    const first = deferred()

    const runs = [
      gate.run(args, async () => {
        order.push(0)
        await first.promise
      }),
      gate.run(args, async () => {
        order.push(1)
      }),
      gate.run(args, async () => {
        order.push(2)
      })
    ]
    await Promise.resolve()
    first.resolve()
    await Promise.all(runs)
    expect(order).toEqual([0, 1, 2])
  })

  it('ships a ceiling below a stock sshd MaxSessions', () => {
    expect(SSH_CHILD_CONCURRENCY).toBeLessThan(10)
    expect(SSH_CHILD_CONCURRENCY).toBeGreaterThan(1)
  })

  it('removes a cancelled waiter without disturbing a running child or FIFO successors', async () => {
    const gate = new SshChildGate(1); const held = deferred(); const controller = new AbortController()
    const args = childArgs(conn, '/cm/cancel.sock', 'true'); const order: string[] = []
    const running = gate.run(args, () => held.promise)
    const cancelled = gate.run(args, async () => { order.push('cancelled') }, controller.signal)
    const refused = expect(cancelled).rejects.toThrow('ssh-queued-command-cancelled')
    const after = gate.run(args, async () => { order.push('after') })
    expect(gate.queued('/cm/cancel.sock')).toBe(2)
    controller.abort(); await refused
    expect(gate.queued('/cm/cancel.sock')).toBe(1); expect(gate.inFlight('/cm/cancel.sock')).toBe(1)
    held.resolve(); await Promise.all([running, after])
    expect(order).toEqual(['after']); expect(gate.inFlight('/cm/cancel.sock')).toBe(0)
  })

  it('keeps a dispatched child counted until it settles after cancellation', async () => {
    const gate = new SshChildGate(1); const held = deferred(); const controller = new AbortController()
    const args = childArgs(conn, '/cm/running.sock', 'true'); const order: string[] = []
    const running = gate.run(args, async () => { order.push('running'); await held.promise }, controller.signal)
    await Promise.resolve()
    const after = gate.run(args, async () => { order.push('after') })
    controller.abort(); await Promise.resolve()
    expect(order).toEqual(['running']); expect(gate.inFlight('/cm/running.sock')).toBe(1)
    held.resolve(); await Promise.all([running, after])
    expect(order).toEqual(['running', 'after']); expect(gate.inFlight('/cm/running.sock')).toBe(0)
  })

  it('refuses an already-cancelled request before acquiring a slot or running a mux command', async () => {
    const gate = new SshChildGate(1); const controller = new AbortController(); controller.abort()
    let calls = 0
    for (const args of [childArgs(conn, '/cm/stopped.sock', 'true'), checkMasterArgs(conn, '/cm/stopped.sock')]) {
      await expect(gate.run(args, async () => { calls++ }, controller.signal)).rejects.toThrow('ssh-queued-command-cancelled')
    }
    expect(calls).toBe(0); expect(gate.inFlight('/cm/stopped.sock')).toBe(0)
  })
})
