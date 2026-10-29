/** Formats recognized by the canvas player. Browser codec availability still varies. */
const VIDEO_MIME = {
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
  mkv: 'video/x-matroska', ogv: 'video/ogg', avi: 'video/x-msvideo'
} as const
const AUDIO_MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', aiff: 'audio/aiff', aif: 'audio/aiff', weba: 'audio/webm'
} as const
export const mediaExtension = (path: string): string => path.split('.').pop()?.toLowerCase() ?? ''
export const isAudioFile = (path: string): boolean => Object.hasOwn(AUDIO_MIME, mediaExtension(path))
export const isVideoFile = (path: string): boolean => Object.hasOwn(VIDEO_MIME, mediaExtension(path))
export const isMediaFile = (path: string): boolean => isAudioFile(path) || isVideoFile(path)
export function mediaMime(path: string): string | undefined {
  const extension = mediaExtension(path)
  return Object.hasOwn(AUDIO_MIME, extension) ? AUDIO_MIME[extension as keyof typeof AUDIO_MIME] :
    Object.hasOwn(VIDEO_MIME, extension) ? VIDEO_MIME[extension as keyof typeof VIDEO_MIME] : undefined
}

/** A host media reference is bound to the persisted node that requested it. */
export interface MediaScope { projectId: string; nodeId: string }
export const VIDEO_NODE_SIZE = { width: 640, height: 420 }
