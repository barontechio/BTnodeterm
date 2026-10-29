/** Images the existing editor preview can render; both host creation and the viewer use this. */
export const IMAGE_MIME: Readonly<Record<string, string>> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml', avif: 'image/avif'
}

export function isImagePath(filePath: string): boolean {
  return Object.hasOwn(IMAGE_MIME, filePath.split('.').pop()?.toLowerCase() ?? '')
}
