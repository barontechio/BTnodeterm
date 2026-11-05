import type { CanvasNodeState } from './types'

export const EDITOR_NODE_SIZE = { width: 660, height: 460 }

/** Common persisted/editor data; placement and id allocation belong to the calling shell. */
export function editorNodeData(filePath: string, sshFs?: boolean): Pick<CanvasNodeState, 'title' | 'color' | 'group' | 'filePath' | 'sshFs'> {
  return { title: filePath.split('/').pop() || 'untitled', color: '#6ac4dc', group: null, filePath,
    ...(sshFs ? { sshFs: true } : {}) }
}
