import type { TransferPrincipal } from '../core/remote-transfers'

/** Cookie tokens remain inside this host registry; RPC clients receive only random file refs. */
export class TransferPrincipals {
  private clients = new Map<number, {token: string; principal: TransferPrincipal}>()
  private sessions = new Map<string, TransferPrincipal>()
  constructor(private valid: (token: string) => boolean) {}
  attach(id: number, token: string | null): void {
    this.forget(id)
    if (!token || !this.valid(token)) return // proxy-only authentication has no stable cookie principal
    let principal = this.sessions.get(token)
    if (!principal) {
      const captured = token
      principal = {current: () => this.sessions.get(captured) === principal && this.valid(captured)}
      this.sessions.set(token, principal)
    }
    this.clients.set(id, {token, principal})
  }
  forClient(id: number): TransferPrincipal | undefined {
    const entry = this.clients.get(id)
    return entry?.principal.current() ? entry.principal : undefined
  }
  forCookie(token: string | undefined): TransferPrincipal | undefined {
    if (!token) return undefined
    const principal = this.sessions.get(token)
    return principal?.current() ? principal : undefined
  }
  forget(id: number): void {
    const entry = this.clients.get(id)
    this.clients.delete(id)
    if (entry && ![...this.clients.values()].some(other => other.token === entry.token)) this.sessions.delete(entry.token)
  }
  dispose(): void { this.clients.clear(); this.sessions.clear() }
}
