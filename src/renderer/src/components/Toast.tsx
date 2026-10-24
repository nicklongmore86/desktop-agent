import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'

const TOAST_MS = 2000
/** A toast with a button stays long enough to reach it. */
const ACTION_TOAST_MS = 8000

/** A button inside a toast ("Open Settings"). */
export interface ToastAction {
  label: string
  onClick: () => void
}

type Notify = (message: string, action?: ToastAction) => void

const ToastContext = createContext<Notify>(() => {})

/** Shows a short, non-blocking message ("Copied"). Outside a provider it does nothing. */
export function useToast(): Notify {
  return useContext(ToastContext)
}

/** Owns the polite live region that announces and shows toasts. */
export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [toast, setToast] = useState<{ id: number; message: string; action?: ToastAction } | null>(
    null,
  )
  const counter = useRef(0)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const notify = useCallback((message: string, action?: ToastAction) => {
    counter.current += 1
    setToast({ id: counter.current, message, ...(action ? { action } : {}) })
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () => {
        setToast(null)
      },
      action ? ACTION_TOAST_MS : TOAST_MS,
    )
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
          <div key={toast.id} className={toast.action ? 'toast toast-action' : 'toast'}>
            <span>{toast.message}</span>
            {toast.action && (
              <button
                type="button"
                className="link-button"
                onClick={() => {
                  const { onClick } = toast.action as ToastAction
                  setToast(null)
                  onClick()
                }}
              >
                {toast.action.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ToastContext>
  )
}
