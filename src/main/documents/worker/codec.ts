import type { DocumentImage } from '../types'
import type { DecodeImage } from '../extract'
import type { EncodeRaster } from '../pdf'

/** A PNG over this size is sent as JPEG instead. */
const PNG_MAX_BYTES = 2 * 1024 * 1024
const JPEG_QUALITIES = [0.85, 0.7, 0.55] as const
/** Each time the lowest JPEG quality is still too big, the image shrinks by this much. */
const SHRINK = 0.75
const MIN_EDGE = 64

async function toBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Encodes what `draw` paints, keeping the output under `maxBytes`. PNG keeps text and line
 * art crisp; a busy image (a scan, a photo) falls back to JPEG, then to lower qualities,
 * then to smaller sizes. JPEG has no alpha, so it is painted on white.
 */
async function encodeCanvas(
  draw: (context: OffscreenCanvasRenderingContext2D, width: number, height: number) => void,
  width: number,
  height: number,
  maxBytes: number,
  jpegFirst: boolean,
): Promise<Omit<DocumentImage, 'source'>> {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('No 2D canvas')
  context.imageSmoothingQuality = 'high'
  draw(context, width, height)
  if (!jpegFirst) {
    const png = await canvas.convertToBlob({ type: 'image/png' })
    if (png.size <= Math.min(PNG_MAX_BYTES, maxBytes)) {
      return { bytes: await toBytes(png), mime: 'image/png', width, height }
    }
  }
  let current = canvas
  for (;;) {
    const flat = new OffscreenCanvas(current.width, current.height)
    const flatContext = flat.getContext('2d')
    if (!flatContext) throw new Error('No 2D canvas')
    flatContext.fillStyle = '#ffffff'
    flatContext.fillRect(0, 0, flat.width, flat.height)
    flatContext.drawImage(current, 0, 0)
    for (const quality of JPEG_QUALITIES) {
      const jpeg = await flat.convertToBlob({ type: 'image/jpeg', quality })
      if (jpeg.size <= maxBytes) {
        return {
          bytes: await toBytes(jpeg),
          mime: 'image/jpeg',
          width: flat.width,
          height: flat.height,
        }
      }
    }
    const nextWidth = Math.round(current.width * SHRINK)
    const nextHeight = Math.round(current.height * SHRINK)
    if (Math.min(nextWidth, nextHeight) < MIN_EDGE) {
      throw new Error('The image could not be encoded small enough')
    }
    const smaller = new OffscreenCanvas(nextWidth, nextHeight)
    const smallerContext = smaller.getContext('2d')
    if (!smallerContext) throw new Error('No 2D canvas')
    smallerContext.imageSmoothingQuality = 'high'
    smallerContext.drawImage(current, 0, 0, nextWidth, nextHeight)
    current = smaller
  }
}

export const encodeRaster: EncodeRaster = (rgba, width, height, maxBytes) =>
  encodeCanvas(
    (context) => {
      context.putImageData(new ImageData(rgba, width, height), 0, 0)
    },
    width,
    height,
    maxBytes,
    false,
  )

/**
 * The canvas transform that draws a `width` x `height` picture turned by an EXIF
 * orientation (2-8) onto a canvas of the turned size.
 */
const TURNS: Record<
  number,
  (w: number, h: number) => [number, number, number, number, number, number]
> = {
  2: (w) => [-1, 0, 0, 1, w, 0],
  3: (w, h) => [-1, 0, 0, -1, w, h],
  4: (_w, h) => [1, 0, 0, -1, 0, h],
  5: () => [0, 1, 1, 0, 0, 0],
  6: (_w, h) => [0, 1, -1, 0, h, 0],
  7: (w, h) => [0, -1, -1, 0, h, w],
  8: (w) => [0, -1, 1, 0, 0, w],
}

/**
 * Decodes with Chromium's codecs, applying EXIF orientation (and `turn`, for pixels a
 * system codec left as stored), then scales to fit `longEdge` (never up) and re-encodes
 * from the canvas. The canvas holds only pixels, so the output carries no EXIF, GPS or
 * other metadata from the original.
 */
export const decodeImage: DecodeImage = async (bytes, kind, longEdge, maxBytes, turn = 1) => {
  const source = await createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
    imageOrientation: 'from-image',
  })
  try {
    const scale = Math.min(1, longEdge / Math.max(source.width, source.height))
    const width = Math.max(1, Math.round(source.width * scale))
    const height = Math.max(1, Math.round(source.height * scale))
    const transform = TURNS[turn]
    const swapped = transform !== undefined && turn >= 5
    return await encodeCanvas(
      (context) => {
        if (transform) context.transform(...transform(width, height))
        context.drawImage(source, 0, 0, width, height)
      },
      swapped ? height : width,
      swapped ? width : height,
      maxBytes,
      kind === 'jpeg',
    )
  } finally {
    source.close()
  }
}
