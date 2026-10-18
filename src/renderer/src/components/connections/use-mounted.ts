import { useEffect, useRef, type RefObject } from 'react'

/** False once the component has unmounted, so late replies never set its state. */
export function useMounted(): RefObject<boolean> {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}
