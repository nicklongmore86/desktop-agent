import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const TOAST_MS = 2000

type Notify = (message: string) => void

const ToastContext = createContext<Notify>(() => {})

/** Shows a short, non-blocking message ("Copied"). Outside a provider it does nothing. */
export function useToast(): Notify {
  return useContext(ToastContext)
}

/** Owns the polite live region that announces and shows toasts. */
export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toast, setToast] = useState<{ id: number; message: string } | null>(null)
  const counter = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const notify = useCallback((message: string) => {
    counter.current += 1
    setToast({ id: counter.current, message })
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setToast(null)
    }, TOAST_MS)
  }, [])

  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    [],
  )

  return (
    <ToastContext value={notify}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && (
          <div key={toast.id} className="toast">
            {toast.message}
          </div>
        )}
      </div>
    </ToastContext>
  )
}
