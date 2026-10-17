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
import { plainText } from '../../plain-text'
import { useProviderModels } from '../../provider-models'
import { useGrantActions } from '../settings/use-grant-actions'
import { ApiKeyForm } from './ApiKeyForm'
import { canGoBack, flowReducer, initialFlow, isConnected, stepNumber, type Step } from './flow'
import { ProviderPanel } from './SignInPanel'
import { SETTLE_WAIT_MS, settledWithin } from './timing'

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

/** Counts preparations across wizards, so a late undo can tell the user has moved on since. */
let generation = 0

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
  // Read while rendering, before the heading takes focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null)
  useEffect(
    () => () => {
      if (opener?.isConnected) opener.focus()
    },
    [opener],
  )

  // The connect step works on the connection chats go to, so make it the current one.
  const connectionId = flow.step === 'connect' ? flow.connection : null
  /**
   * The latest preparation. `live` goes false when it is cancelled (another connection, Back,
   * Close). `switching` settles once it has stopped changing the provider (the read and the
   * switch are over, or it never got that far); the key lookup after is not part of it. A new
   * preparation, and abandoning, wait for it, but only up to SETTLE_WAIT_MS.
   */
  interface Run {
    live: boolean
    switching: Promise<void>
    done: Promise<void>
  }
  const lastRun = useRef<Run>({
    live: false,
    switching: Promise.resolve(),
    done: Promise.resolve(),
  })
  /** The undo in progress, which a new preparation waits for. */
  const abandoning = useRef<Promise<void> | null>(null)
  useEffect(() => {
    if (!connectionId) return
    const earlier = lastRun.current
    const undoing = abandoning.current
    earlier.live = false
    generation += 1
    let release = (): void => {}
    const run: Run = {
      live: true,
      switching: new Promise<void>((done) => {
        release = done
      }),
      done: Promise.resolve(),
    }
    lastRun.current = run
    // A function, so each check reads the flag as it is now (it can change across an await).
    const cancelled = (): boolean => !run.live
    run.done = (async () => {
      let next: ProviderStatus | null = null
      let failed = false
      try {
        await settledWithin(Promise.all([earlier.switching, undoing]), SETTLE_WAIT_MS)
        if (cancelled()) return
        const now = await api.provider.get()
        if (cancelled()) return
        if (previous.current === null) {
          previous.current = now.provider
          added.current = !overview.rows.find((row) => row.info.id === connectionId)?.configured
        }
        next = now
        if (now.provider !== connectionId) {
          // Past this point the switch happens whatever the user does; abandon puts it back.
          next = await props.onSwitchProvider(connectionId)
          if (cancelled()) return
        }
      } catch {
        failed = true
      } finally {
        release()
      }
      let found: { status: ProviderStatus | null; keySaved: boolean; error: string | null }
      if (next && !failed) {
        const key = await api.apiKey.status(connectionId).catch(() => null)
        found = { status: next, keySaved: key?.saved ?? false, error: null }
      } else {
        found = {
          status: null,
          keySaved: false,
          error: 'Could not switch to this connection. Try again.',
        }
      }
      if (!cancelled()) setPrep({ connection: connectionId, attempt, ...found })
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

  /** Puts the previous connection back and drops the one the wizard added. */
  const restore = async (
    target: ConnectionId,
    back: ConnectionId | null,
    wasAdded: boolean,
  ): Promise<void> => {
    try {
      await api.provider.cancelLogin()
      if (back && back !== target) {
        props.onProvider(await props.onSwitchProvider(back))
        if (wasAdded) await api.connections.remove(target)
      }
    } catch {
      // The connection stays listed as not set up; Settings can remove it.
    }
  }

  /** Puts back what the wizard changed for a connection the user did not finish setting up. */
  const abandon = (): Promise<void> => {
    abandoning.current ??= (async () => {
      const run = lastRun.current
      run.live = false
      const target = flow.connection
      const back = previous.current
      const wasAdded = added.current
      // Wait for a switch already started, but not forever.
      const landed = await settledWithin(run.switching, SETTLE_WAIT_MS)
      previous.current = null
      added.current = false
      if (target && !connectedOnce.current) {
        if (landed) {
          await restore(target, back, wasAdded)
        } else if (back && back !== target) {
          // It may still land. When it does, put things back, unless the user has chosen a
          // connection of their own meanwhile (another wizard run, or the picker).
          const mine = generation
          void run.switching.then(async () => {
            if (mine !== generation) return
            const now = await api.provider.get().catch(() => null)
            if (mine !== generation || now?.provider !== target) return
            await restore(target, back, wasAdded)
            overview.refresh()
          })
        }
      }
      overview.refresh()
    })().finally(() => {
      abandoning.current = null
    })
    return abandoning.current
  }

  const close = (): void => {
    // Closing never hangs on a provider call that does not answer.
    void settledWithin(abandon(), SETTLE_WAIT_MS * 2).finally(() => {
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
    const notice = info.notice
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
  const rawLabel = choice?.options.find((option) => option.id === picked)?.label
  const pickedLabel = rawLabel === undefined ? null : plainText(rawLabel)
  useEffect(() => {
    onLabel(pickedLabel)
  }, [pickedLabel, onLabel])
  if (!loaded) return <p role="status">Loading models…</p>
  const localWarning = info.capabilities.authKind === 'local' && (
    <>
      <p className="connection-notice" role="note">
        Smaller local models may not use file tools reliably.
      </p>
      {/* The server's own caveat, as main words it (plain text). */}
      {choice?.warning && <p className="settings-hint">{plainText(choice.warning)}</p>}
    </>
  )
  if (!choice) {
    return (
      <div className="wizard-section">
        {info.capabilities.listsModels ? (
          <>
            <p>
              {plainText(models.failure?.message ?? `No models found for ${info.title} yet.`)} Add
              one there, then check again.
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
            <span className="wizard-model-name">{plainText(option.label)}</span>
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
          {plainText(message)}
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
