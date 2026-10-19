// The ImageScaler used by the app: Electron's nativeImage (no extra native
// dependency). It decodes PNG and JPEG everywhere; other formats return null and
// are attached only when already small enough (see prepareImage).
import { nativeImage } from 'electron'
import type { ImageScaler } from './image'

export const nativeImageScaler: ImageScaler = {
  scale(bytes, mime, maxSide) {
    if (mime !== 'image/png' && mime !== 'image/jpeg') return Promise.resolve(null)
    const image = nativeImage.createFromBuffer(bytes)
    if (image.isEmpty()) return Promise.resolve(null)
    const { width, height } = image.getSize()
    const resized =
      width >= height
        ? image.resize({ width: maxSide, quality: 'best' })
        : image.resize({ height: maxSide, quality: 'best' })
    if (resized.isEmpty()) return Promise.resolve(null)
    return Promise.resolve(
      mime === 'image/jpeg'
        ? { bytes: resized.toJPEG(85), mime }
        : { bytes: resized.toPNG(), mime: 'image/png' },
    )
  },
}
