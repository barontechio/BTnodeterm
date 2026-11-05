import { normalizeDynamicGroupState } from '@shared/dynamic-groups'

/** Passive layout facts only: a reserved rectangle has no process or launch state. */
export function GroupReservations({ state, color }: { state: unknown; color: string }) {
  const slots = normalizeDynamicGroupState(state)?.reservations.filter((r) => r.state === 'reserved') ?? []
  return <>{slots.map((r) => <div key={r.id} data-reservation-id={r.id}
    aria-label={`Reserved space: ${r.id}`}
    style={{ position: 'absolute', left: r.position.x, top: r.position.y, width: r.width, height: r.height,
      boxSizing: 'border-box', border: `1px dashed ${color}`, borderRadius: 8,
      opacity: 0.5, pointerEvents: 'none', overflow: 'hidden' }}>
    <span style={{ display: 'block', padding: '8px 12px', fontSize: 12, color }}>Reserved · {r.id}</span>
  </div>)}</>
}
