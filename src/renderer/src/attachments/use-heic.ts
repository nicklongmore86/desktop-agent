import { useEffect, useState } from 'react'
import type { HeicSupport } from '../../../shared/attachments'
import { useApi } from '../api'

/**
 * Whether this computer can decode HEIC photos, as main found it (once per session). Null
 * until known; a failure reads as not supported.
 */
export function useHeicSupport(): HeicSupport | null {
  const api = useApi()
  const [support, setSupport] = useState<HeicSupport | null>(null)
  useEffect(() => {
    let current = true
    api.attachments.heicSupport().then(
      (value) => {
        if (current) setSupport(value)
      },
      () => {
        if (current)
          setSupport({
            supported: false,
            reason: 'Could not check whether this computer can decode HEIC photos.',
          })
      },
    )
    return () => {
      current = false
    }
  }, [api])
  return support
}
