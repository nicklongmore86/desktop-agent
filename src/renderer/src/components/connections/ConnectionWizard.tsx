import { useEffect, useEffectEvent, useId, useReducer, useRef, useState } from 'react'
import {
  PROVIDER_CARDS,
  accessOf,
  accessOptions,
  providerOf,
  type AccessOption,
  type ProviderKey,
} from '../../../../shared/access-matrix'
import type { GrantsState, ProviderStatus } from '../../../../shared/ipc'
import type { ConnectionId, ConnectionInfo } from '../../../../shared/ipc-connections'
import { useApi } from '../../api'
import { useConnectionOverview } from '../../connections'
import { useProviderModels } from '../../provider-models'
import { useGrantActions } from '../settings/use-grant-actions'
import { ApiKeyForm } from './ApiKeyForm'
import { canGoBack, flowReducer, initialFlow, isConnected, stepNumber, type Step } from './flow'
import { noticeOf } from './notice'
import { ProviderPanel } from './SignInPanel'

export interface ConnectionWizardProps {
  /** An approval is open: the wizard hides and goes inert, so the approval comes first. */
  suspended: boolean
  /** Nothing is set up yet: closing says "Skip for now". */
  firstRun: boolean
  /** Open on the connect step of a connection that is already listed (Set up, Sign in). */
  startAt: ConnectionId | null
  grants: GrantsState | null
  onGrants: (grants: GrantsState) => void
  /** The app keeps the current connection's status. */
  onProvider: (status: ProviderStatus) => void
  /** Switches the connection chats go to; the chat hides the old conversation meanwhile. */
  onSwitchProvider: (connection: ConnectionId) => Promise<ProviderStatus>
  onClose: () => void
}

const FOCUSABLE =
  'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]'

const TITLES: Record<Step, string> = {
  provider: 'Which AI do you want to use?',
  access: 'How do you want to use it?',
  connect: 'Connect',
  model: 'Pick a model',
  folder: 'Choose a folder to work in',
  done: 'You’re all set',
}

/**
 * Add connection: the first-run wizard and Settings → Add connection are the
 * same flow. It is built from connections.list() and the static access matrix
 * (src/shared/access-matrix.ts), so a connection main registers appears in it
 * without changes here. Plain-text rendering throughout: labels, model names
 * and errors are never HTML.
 */
export function ConnectionWizard(props: ConnectionWizardProps): React.JSX.Element {
  const { suspended, firstRun, startAt, onClose } = props
  const api = useApi()
  const overview = useConnectionOverview()
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [flow, dispatch] = useReducer(flowReducer, initialFlow)
  /** The connection chats went to before the wizard switched them, to put back on cancel. */
  const previous = useRef<ConnectionId | null>(null)
  /** The wizard added the connection to the set-up ones, so cancelling takes it out again. */
  const added = useRef(false)
  const connectedOnce = useRef(false)
  /** What the connect step found out about its connection; keyed so a stale one is never shown. */
  const [prep, setPrep] = useState<{
    connection: ConnectionId
    attempt: number
    status: ProviderStatus | null
    keySaved: boolean
    error: string | null
  } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [modelLabel, setModelLabel] = useState<string | null>(null)

  const infos = overview.rows.map((row) => row.info)
  const context = { connections: infos, showPersonalUse: overview.state?.showPersonalUse ?? true }
  const info = infos.find((entry) => entry.id === flow.connection)

  // Opened on an existing connection: start at its connect step.
  const started = useRef(false)
  useEffect(() => {
    if (started.current || !startAt || !overview.loaded) return
    const target = infos.find((entry) => entry.id === startAt)
    if (!target) return
    started.current = true
    const provider = providerOf(target)
    if (!provider) return
    const access = accessOf(provider, target.id) ?? target.access
    dispatch({ type: 'start-at', provider, access, connection: target.id })
  })

  // Focus the step's heading when the step changes, so it is announced and Tab starts there.
  useEffect(() => {
    if (!suspended) heading.current?.focus()
  }, [flow.step, suspended])
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    return () => {
      if (opener?.isConnected) opener.focus()
    }
  }, [])

  // The connect step works on the connection chats go to, so make it the current one.
  const connectionId = flow.step === 'connect' ? flow.connection : null
  useEffect(() => {
    if (!connectionId) return
    const run = { live: true }
    void (async () => {
      let found: { status: ProviderStatus | null; keySaved: boolean; error: string | null }
      try {
        const now = await api.provider.get()
        if (previous.current === null) {
          previous.current = now.provider
          added.current = !overview.rows.find((row) => row.info.id === connectionId)?.configured
        }
        const next =
          now.provider === connectionId ? now : await props.onSwitchProvider(connectionId)
        const key = await api.apiKey.status(connectionId).catch(() => null)
        found = { status: next, keySaved: key?.saved ?? false, error: null }
      } catch {
        found = {
          status: null,
          keySaved: false,
          error: 'Could not switch to this connection. Try again.',
        }
      }
      if (run.live) setPrep({ connection: connectionId, attempt, ...found })
    })()
    return () => {
      run.live = false
    }
    // Only a different connection (or Try again) restarts it; the rest is read when it runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, connectionId, attempt])
  const current = prep?.connection === connectionId && prep.attempt === attempt ? prep : null
  const preparing = connectionId !== null && current === null
  const status = current?.status ?? null
  const keySaved = current?.keySaved ?? false
  const prepareError = current?.error ?? null
  const setStatus = (next: ProviderStatus): void => {
    setPrep((value) => (value ? { ...value, status: next } : value))
  }

  /** Puts back what the wizard changed for a connection the user did not finish setting up. */
  const abandon = async (): Promise<void> => {
    const target = flow.connection
    if (!target || connectedOnce.current) return
    try {
      await api.provider.cancelLogin()
      const back = previous.current
      if (back && back !== target) {
        props.onProvider(await props.onSwitchProvider(back))
        if (added.current) await api.connections.remove(target)
      }
    } catch {
      // The connection stays listed as not set up; Settings can remove it.
    }
    previous.current = null
    added.current = false
    overview.refresh()
  }

  const close = (): void => {
    void abandon().finally(() => {
      onClose()
    })
  }
  const back = (): void => {
    if (flow.step === 'connect') {
      void abandon()
      setPrep(null)
    }
    dispatch({ type: 'back' })
  }

  const connected = info
    ? info.capabilities.authKind === 'api-key'
      ? keySaved
      : isConnected(status)
    : false

  /**
   * Esc goes back a step (or closes) and Tab stays inside. Heard on the document, in the
   * capture phase, so they work when focus has fallen to the page because the focused
   * button went away, and so Esc never also stops a running reply. While an approval is
   * open (`suspended`) the wizard is hidden and leaves both keys to it.
   */
  const onKey = useEffectEvent((event: KeyboardEvent): void => {
    if (suspended) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (flow.step === 'access' || flow.step === 'connect') back()
      else close()
      return
    }
    if (event.key !== 'Tab') return
    const items = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
      (item) => item.checkVisibility(),
    )
    const first = items[0]
    const last = items.at(-1)
    const active = document.activeElement
    const inside = dialog.current?.contains(active) ?? false
    if (!inside || (event.shiftKey && (active === first || active === heading.current))) {
      event.preventDefault()
      ;(event.shiftKey ? last : first)?.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first?.focus()
    }
  })
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      onKey(event)
    }
    document.addEventListener('keydown', listener, true)
    return () => {
      document.removeEventListener('keydown', listener, true)
    }
  }, [])

  const progress = stepNumber(flow.step)
  const card = PROVIDER_CARDS.find((entry) => entry.key === flow.provider)
  const title =
    flow.step === 'access' && card
      ? `How do you want to use ${card.name}?`
      : flow.step === 'connect' && info
        ? info.capabilities.authKind === 'runtime-login'
          ? `Sign in to ${card?.name ?? info.title}`
          : info.capabilities.authKind === 'api-key'
            ? `Add your ${info.title} key`
            : info.capabilities.authKind === 'local'
              ? `Find ${info.title}`
              : `Connect ${info.title}`
        : flow.step === 'connect'
          ? 'Which one do you use?'
          : TITLES[flow.step]

  return (
    <div className="wizard-overlay" hidden={suspended} inert={suspended}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="wizard"
      >
        <header className="wizard-header">
          <p className="wizard-progress">
            {flow.step === 'done'
              ? 'Done'
              : `Step ${String(progress.current)} of ${String(progress.total)}`}
          </p>
          <button type="button" aria-label="Close" className="wizard-close" onClick={close}>
            ×
          </button>
        </header>
        <div className="wizard-body">
          <h2 id={titleId} ref={heading} tabIndex={-1}>
            {title}
          </h2>
          {flow.step === 'provider' && (
            <ProviderStep
              onPick={(provider) => {
                dispatch({ type: 'provider', provider })
              }}
            />
          )}
          {flow.step === 'access' && flow.provider && (
            <AccessStep
              provider={flow.provider}
              options={accessOptions(flow.provider, context)}
              loaded={overview.loaded}
              onPick={(option) => {
                const only = option.connections.length === 1 ? option.connections[0] : undefined
                dispatch({ type: 'access', access: option.access, connection: only?.id ?? null })
              }}
            />
          )}
          {flow.step === 'connect' && !info && flow.provider && flow.access && (
            <PickConnection
              options={
                accessOptions(flow.provider, context).find(
                  (option) => option.access === flow.access,
                )?.connections ?? []
              }
              onPick={(id) => {
                dispatch({ type: 'connection', connection: id })
              }}
            />
          )}
          {flow.step === 'connect' && info && (
            <ConnectStep
              info={info}
              status={status}
              keySaved={keySaved}
              connected={connected}
              preparing={preparing}
              error={prepareError}
              onRetry={() => {
                setAttempt((value) => value + 1)
              }}
              onStatus={(next) => {
                setStatus(next)
                props.onProvider(next)
              }}
              onKeySaved={() => {
                setPrep((value) => (value ? { ...value, keySaved: true } : value))
              }}
              onContinue={() => {
                connectedOnce.current = true
                if (status) props.onProvider(status)
                overview.refresh()
                dispatch({ type: 'connected' })
              }}
            />
          )}
          {flow.step === 'model' && info && (
            <ModelStep
              info={info}
              onLabel={setModelLabel}
              onContinue={() => {
                dispatch({ type: 'model-done' })
              }}
            />
          )}
          {flow.step === 'folder' && (
            <FolderStep
              grants={props.grants}
              onGrants={props.onGrants}
              onContinue={() => {
                dispatch({ type: 'folder-done' })
              }}
            />
          )}
          {flow.step === 'done' && info && (
            <div className="wizard-section">
              <p role="status" className="wizard-done">
                You’re set up with {info.label} · {modelLabel ?? 'the default model'}.
              </p>
              <div className="wizard-actions">
                <button type="button" className="button-primary" onClick={close}>
                  Start chatting
                </button>
              </div>
            </div>
          )}
        </div>
        <footer className="wizard-footer">
          {flow.step === 'provider' ? (
            <p className="settings-hint">You can add more later and switch any time.</p>
          ) : null}
          <div className="wizard-nav">
            {canGoBack(flow) && (
              <button type="button" onClick={back}>
                Back
              </button>
            )}
            {flow.step !== 'done' && (
              <button type="button" className="wizard-skip" onClick={close}>
                {firstRun && flow.step === 'provider' ? 'Skip for now' : 'Cancel'}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  )
}

function ProviderStep({ onPick }: { onPick: (provider: ProviderKey) => void }): React.JSX.Element {
  return (
    <ul className="wizard-cards" aria-label="Providers">
      {PROVIDER_CARDS.map((card) => (
        <li key={card.key}>
          <button
            type="button"
            className="provider-card wizard-card"

            onClick={() => {
              onPick(card.key)
            }}
          >
            <span>
              <strong>{card.name}</strong>
              <small>{card.blurb}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function AccessStep({
  provider,
  options,
  loaded,
  onPick,
}: {
  provider: ProviderKey
  options: AccessOption[]
  loaded: boolean
  onPick: (option: AccessOption) => void
}): React.JSX.Element {
  const name = useId()
  const [choice, setChoice] = useState<AccessOption['access'] | null>(null)
  const selected =
    options.find((option) => option.access === choice) ??
    options.find((option) => option.available) ??
    options[0]
  if (!loaded) return <p role="status">Loading…</p>
  return (
    <div className="wizard-section">
      <div role="radiogroup" aria-label="Access type" className="wizard-segments">
        {options.map((option) => (
          <label
            key={`${provider}-${option.access}`}
            className="wizard-segment"
            data-unavailable={option.available ? undefined : ''}
          >
            <input
              type="radio"
              name={name}
              value={option.access}
              checked={selected?.access === option.access}
              aria-disabled={option.available ? undefined : 'true'}
              onChange={() => {
                setChoice(option.access)
              }}
            />
            <span className="wizard-segment-label">{option.label}</span>
            <span className={option.available ? 'chip chip-ok' : 'chip chip-off'}>
              {option.available ? 'Available' : 'Not available'}
            </span>
          </label>
        ))}
      </div>
      {selected && (
        <div className="wizard-detail" aria-live="polite">
          <p>{selected.text}</p>
          {selected.available && selected.note && <p className="settings-hint">{selected.note}</p>}
          {!selected.available && selected.instead && (
            <button
              type="button"
              onClick={() => {
                setChoice(selected.instead?.access ?? null)
              }}
            >
              {selected.instead.label}
            </button>
          )}
        </div>
      )}
      <div className="wizard-actions">
        <button
          type="button"
          className="button-primary"
          disabled={!selected?.available}
          onClick={() => {
            if (selected?.available) onPick(selected)
          }}
        >
          Continue
        </button>
      </div>
    </div>
  )
}

function PickConnection({
  options,
  onPick,
}: {
  options: ConnectionInfo[]
  onPick: (id: ConnectionId) => void
}): React.JSX.Element {
  return (
    <ul className="wizard-cards" aria-label="Local apps">
      {options.map((option) => (
        <li key={option.id}>
          <button
            type="button"
            className="provider-card wizard-card"

            onClick={() => {
              onPick(option.id)
            }}
          >
            <span>
              <strong>{option.title}</strong>
              <small>{option.description}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function ConnectStep({
  info,
  status,
  keySaved,
  connected,
  preparing,
  error,
  onRetry,
  onStatus,
  onKeySaved,
  onContinue,
}: {
  info: ConnectionInfo
  status: ProviderStatus | null
  keySaved: boolean
  connected: boolean
  preparing: boolean
  error: string | null
  onRetry: () => void
  onStatus: (status: ProviderStatus) => void
  onKeySaved: () => void
  onContinue: () => void
}): React.JSX.Element {
  const [replacing, setReplacing] = useState(false)
  const kind = info.capabilities.authKind
  if (preparing) return <p role="status">Getting ready…</p>
  if (error)
    return (
      <div className="wizard-section">
        <p className="settings-error" role="alert">
          {error}
        </p>
        <button type="button" onClick={onRetry}>
          Try again
        </button>
      </div>
    )
  const continueButton = (
    <div className="wizard-actions">
      <button type="button" className="button-primary" onClick={onContinue}>
        Continue
      </button>
    </div>
  )
  if (kind === 'api-key') {
    const notice = noticeOf(info)
    return (
      <div className="wizard-section">
        <p className="settings-hint">{info.description}</p>
        {keySaved && !replacing ? (
          <>
            <p role="status" className="settings-status">
              Key saved and encrypted by Windows. It can’t be viewed again.
            </p>
            <div className="wizard-actions">
              <button
                type="button"
                onClick={() => {
                  setReplacing(true)
                }}
              >
                Replace key
              </button>
              <button type="button" className="button-primary" onClick={onContinue}>
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <ApiKeyForm
              connection={info.id}
              label={info.title}
              saved={keySaved}
              notice={notice}
              onSaved={() => {
                setReplacing(false)
                onKeySaved()
              }}
            />
            {keySaved && continueButton}
          </>
        )}
      </div>
    )
  }
  // Sign in through the connection's own runtime, or find a local server.
  return (
    <div className="wizard-section">
      <p className="settings-hint">{info.description}</p>
      <ProviderPanel connection={info} status={status} onStatus={onStatus} />
      {connected && continueButton}
    </div>
  )
}

function ModelStep({
  info,
  onLabel,
  onContinue,
}: {
  info: ConnectionInfo
  onLabel: (label: string | null) => void
  onContinue: () => void
}): React.JSX.Element {
  const models = useProviderModels(info.id)
  const name = useId()
  const [error, setError] = useState<string | null>(null)
  const { choice, loaded } = models
  const picked = choice ? (choice.selected ?? choice.recommended ?? choice.options[0]?.id) : null
  const pickedLabel = choice?.options.find((option) => option.id === picked)?.label ?? null
  useEffect(() => {
    onLabel(pickedLabel)
  }, [pickedLabel, onLabel])
  if (!loaded) return <p role="status">Loading models…</p>
  const localWarning = info.capabilities.authKind === 'local' && (
    <p className="connection-notice" role="note">
      Smaller local models may not use file tools reliably.
    </p>
  )
  if (!choice) {
    return (
      <div className="wizard-section">
        {info.capabilities.listsModels ? (
          <>
            <p>
              {models.failure?.message ?? `No models found for ${info.title} yet.`} Add one there,
              then check again.
            </p>
            {localWarning}
            <div className="wizard-actions">
              <button type="button" onClick={models.refresh}>
                Check again
              </button>
              <button type="button" className="button-primary" onClick={onContinue}>
                Continue
              </button>
            </div>
          </>
        ) : (
          <>
            <p>{info.shortLabel} chooses the model for you, so there’s nothing to pick here.</p>
            <div className="wizard-actions">
              <button type="button" className="button-primary" onClick={onContinue}>
                Continue
              </button>
            </div>
          </>
        )}
      </div>
    )
  }
  return (
    <div className="wizard-section">
      {localWarning}
      <div role="radiogroup" aria-label="Model" className="wizard-models">
        {choice.options.map((option) => (
          <label key={option.id} className="provider-card wizard-model">
            <input
              type="radio"
              name={name}
              value={option.id}
              checked={picked === option.id}
              onChange={() => {
                setError(null)
                void models.select(option.id).then((saved) => {
                  if (!saved) setError('Could not change the model.')
                })
              }}
            />
            <span className="wizard-model-name">{option.label}</span>
            {choice.recommended === option.id && <span className="chip chip-ok">Recommended</span>}
          </label>
        ))}
      </div>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="wizard-actions">
        <button type="button" className="button-primary" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  )
}

function FolderStep({
  grants,
  onGrants,
  onContinue,
}: {
  grants: GrantsState | null
  onGrants: (grants: GrantsState) => void
  onContinue: () => void
}): React.JSX.Element {
  const { message, busy, add } = useGrantActions(onGrants)
  const roots = grants?.roots ?? []
  return (
    <div className="wizard-section">
      <p className="settings-hint">
        Desktop Agent can only see folders you grant, and you approve every change and shell
        command.
      </p>
      {message && (
        <p className="settings-error" role="alert">
          {message}
        </p>
      )}
      {roots.length > 0 && (
        <ul className="grant-list" aria-label="Granted folders">
          {roots.map((root) => (
            <li key={root}>
              <code>{root}</code>
            </li>
          ))}
        </ul>
      )}
      <div className="wizard-actions">
        <button
          type="button"
          className={roots.length > 0 ? undefined : 'button-primary'}

          disabled={busy}
          onClick={() => {
            void add()
          }}
        >
          {roots.length > 0 ? 'Add another folder…' : 'Choose a folder…'}
        </button>
        <button
          type="button"
          className={roots.length > 0 ? 'button-primary' : undefined}
          onClick={onContinue}
        >
          {roots.length > 0 ? 'Continue' : 'Skip for now'}
        </button>
      </div>
    </div>
  )
}
