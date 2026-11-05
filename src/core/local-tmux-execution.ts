/** Host-private physical execution evidence. Never serialized through NodeApi. */
export interface LocalTmuxExecution {
  readonly socket: string
  readonly socketPath: string
  readonly server: string
  readonly session: string
  readonly sessionId: string
  readonly paneId: string
  readonly panePid: number
  readonly paneBirth: string
  readonly clientPid: number
  readonly clientBirth: string
  readonly current: () => boolean
}
export function sameLocalTmuxExecution(a: LocalTmuxExecution, b: LocalTmuxExecution): boolean {
  return a.socket === b.socket && a.socketPath === b.socketPath && a.server === b.server &&
    a.session === b.session && a.sessionId === b.sessionId && a.paneId === b.paneId &&
    a.panePid === b.panePid && a.paneBirth === b.paneBirth &&
    a.clientPid === b.clientPid && a.clientBirth === b.clientBirth
}
