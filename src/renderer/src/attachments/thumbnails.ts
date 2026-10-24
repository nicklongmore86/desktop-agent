import { ATTACHMENT_LIMITS } from '../../../shared/attachments'

/** Image types the chip can preview (the CSP allows `blob:` images for these previews). */
const PREVIEW_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
/** Room for a full message of chips plus files still landing; the oldest past this is revoked. */
const MAX_CACHED = ATTACHMENT_LIMITS.maxPerMessage * 2

/** `blob:` previews by attachment id, for staged chips. Each is revoked once its chip goes. */
const cache = new Map<string, string>()

export function thumbnailFor(id: string): string | undefined {
  return cache.get(id)
}

/**
 * Keeps a `blob:` preview of an image the user dropped or pasted, unless it is not a
 * previewable image or `id` already has one.
 */
export function rememberThumbnail(id: string, blob: Blob): void {
  if (cache.has(id)) return
  if (!PREVIEW_MIMES.has(blob.type) || blob.size > ATTACHMENT_LIMITS.imageBytes) return
  cache.set(id, URL.createObjectURL(blob))
  for (const [oldest, url] of cache) {
    if (cache.size <= MAX_CACHED) break
    URL.revokeObjectURL(url)
    cache.delete(oldest)
  }
}

/** Revokes the previews of these attachments (their chips were removed, sent or cleared). */
export function releaseThumbnails(ids: Iterable<string>): void {
  for (const id of ids) {
    const url = cache.get(id)
    if (url === undefined) continue
    URL.revokeObjectURL(url)
    cache.delete(id)
  }
}

export function clearThumbnails(): void {
  releaseThumbnails([...cache.keys()])
}
