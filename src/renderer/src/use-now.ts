import { useEffect, useState } from 'react'

/** The current time, refreshed every second while `active`; otherwise it stays as it was. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [active])
  return now
}
