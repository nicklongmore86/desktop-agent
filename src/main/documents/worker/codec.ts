import type { DecodeImage } from '../extract'
import type { EncodeRaster } from '../pdf'

/** A rendered page over this size is sent as JPEG instead of PNG. */
const PNG_MAX_BYTES = 2 * 1024 * 1024

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/** PNG keeps rendered text and line art crisp; a busy page (a scan) falls back to JPEG. */
export const encodeRaster: EncodeRaster = async (rgba, width, height) => {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D canvas')
  context.putImageData(new ImageData(rgba, width, height), 0, 0)
  const png = await canvas.convertToBlob({ type: 'image/png' })
  if (png.size <= PNG_MAX_BYTES) return { bytes: await toBytes(png), mime: 'image/png' }
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
  return { bytes: await toBytes(jpeg), mime: 'image/jpeg' }
}

/**
 * Decodes with Chromium's codecs, applying EXIF orientation, then scales to fit
 * `longEdge` (never up) and re-encodes from the canvas. The canvas holds only pixels,
 * so the output carries no EXIF, GPS or other metadata from the original.
 */
export const decodeImage: DecodeImage = async (bytes, kind, longEdge) => {
  const source = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    imageOrientation: 'from-image',
  })
  try {
    const scale = Math.min(1, longEdge / Math.max(source.width, source.height))
    const width = Math.max(1, Math.round(source.width * scale))
    const height = Math.max(1, Math.round(source.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('No 2D canvas')
    context.imageSmoothingQuality = 'high'
    context.drawImage(source, 0, 0, width, height)
    const mime = kind === 'jpeg' ? 'image/jpeg' : 'image/png'
    const blob = await canvas.convertToBlob(
      mime === 'image/jpeg' ? { type: mime, quality: 0.9 } : { type: mime },
    )
    return { bytes: await toBytes(blob), mime, width, height }
  } finally {
    source.close()
  }
}
