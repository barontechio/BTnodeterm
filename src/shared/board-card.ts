import type { NodeKind } from './types'

/** Membership and display title of a session-source card, shared by live and stored canvases. */
export function boardCard(node: { id: string; kind?: NodeKind; title?: string; text?: string }): { id: string; title: string } | null {
  if (node.kind === 'terminal') return { id: node.id, title: node.title ?? '' }
  if (node.kind === 'browser') return { id: node.id, title: node.title || 'Browser' }
  if (node.kind === 'sticky') return {
    id: node.id, title: (node.text ?? '').trim().split('\n')[0].replace(/^#{1,6}\s+/, '').trim().slice(0, 80) || 'Note'
  }
  return null
}
