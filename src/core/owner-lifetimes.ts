/** Stable host-only owner identity for one authenticated UI connection/document lifetime. */
export interface AccountOwner {
  active(): boolean
  onDeparture(callback: () => void): () => void
}

export class OwnerLifetimes {
  private entries = new Map<number, { owner: AccountOwner; depart(): void }>()
  private disposed = false
  get(id: number, eligible: () => boolean): AccountOwner {
    if (this.disposed || !eligible()) throw new Error('owner-required')
    const previous = this.entries.get(id)
    if (previous?.owner.active()) return previous.owner
    this.forget(id)
    let live = true
    const listeners = new Set<() => void>()
    const owner: AccountOwner = {
      active: () => !this.disposed && live && eligible(),
      onDeparture: (listener) => {
        if (!owner.active()) { listener(); return () => {} }
        listeners.add(listener); return () => { listeners.delete(listener) }
      }
    }
    this.entries.set(id, { owner, depart: () => {
      live = false
      for (const listener of [...listeners]) { try { listener() } catch { /* release siblings too */ } }
      listeners.clear()
    } })
    return owner
  }
  forget(id: number): void {
    const entry = this.entries.get(id); this.entries.delete(id); entry?.depart()
  }
  dispose(): void { this.disposed = true; for (const id of [...this.entries.keys()]) this.forget(id) }
}
