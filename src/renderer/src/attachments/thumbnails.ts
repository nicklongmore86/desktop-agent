import { ATTACHMENT_LIMITS } from '../../../shared/attachments'

/** Image types the chip can preview (the CSP allows `data:` images only). */
const PREVIEW_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
const MAX_CACHED = 60

/** Small previews by attachment id, kept for this window's life so a sent message still shows them. */
const cache = new Map<string, string>()

export function thumbnailFor(id: string): string | undefined {
  return cache.get(id)
}

export function rememberThumbnail(id: string, url: string): void {
  cache.delete(id)
  cache.set(id, url)
  const oldest = cache.keys().next()
  if (cache.size > MAX_CACHED && !oldest.done) cache.delete(oldest.value)
}

export function clearThumbnails(): void {
  cache.clear()
}

/** A `data:` URL for an image the user dropped or pasted, or null when it is not a previewable image. */
export function readThumbnail(blob: Blob): Promise<string | null> {
  if (!PREVIEW_MIMES.has(blob.type) || blob.size > ATTACHMENT_LIMITS.imageBytes)
    return Promise.resolve(null)
  return new Promise((done) => {
    const reader = new FileReader()
    reader.onload = () => {
      done(
        typeof reader.result === 'string' && reader.result.startsWith('data:image/')
          ? reader.result
          : null,
      )
    }
    reader.onerror = () => {
      done(null)
    }
    reader.readAsDataURL(blob)
  })
}
