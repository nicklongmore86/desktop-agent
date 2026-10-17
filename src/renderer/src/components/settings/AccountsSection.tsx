import { useEffect, useId, useState, type SubmitEvent } from 'react'
import { KEY_HELP } from '../../../../shared/access-matrix'
import type { ApiKeyStatus } from '../../../../shared/ipc'
import {
  ANTHROPIC_API,
  DEFAULT_CONNECTION,
  type ConnectionId,
  type ConnectionInfo,
} from '../../../../shared/ipc-connections'
import { useApi } from '../../api'
import { useConnectionOverview, type ConnectionRow } from '../../connections'
import { useProviderModels } from '../../provider-models'
import { ProviderPanel, useMounted } from '../connections/SignInPanel'
import type { SettingsPanelProps } from '../SettingsPanel'
import { UsageSection } from './UsageSection'

export function ApiKeySection({
  keyStatus,
  onKeyStatus,
  connection = ANTHROPIC_API,
  title = 'Anthropic API key',
}: Pick<SettingsPanelProps, 'keyStatus' | 'onKeyStatus'> & {
  /** The key's connection; Anthropic API is the one the key calls default to. */
  connection?: ConnectionId
  title?: string
}): React.JSX.Element {
  const api = useApi()
  const inputId = useId()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState(false)
  const saved = keyStatus?.saved ?? false
  const showInput = !saved || editing

  const run = async (operation: () => Promise<ApiKeyStatus>): Promise<void> => {
    setBusy(true)
    try {
      const status = await operation()
      onKeyStatus(status)
      if (!status.error) {
        setDraft('')
        setEditing(false)
      }
    } catch {
      onKeyStatus({ saved, error: 'The request failed. Try again.' })
    } finally {
      setBusy(false)
    }
  }

  const save = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!draft.trim()) return
    void run(() =>
      connection === ANTHROPIC_API ? api.apiKey.set(draft) : api.apiKey.set(draft, connection),
    )
  }

  return (
    <section className="settings-section" aria-labelledby={`${inputId}-title`}>
      <h3 id={`${inputId}-title`}>{title}</h3>
      <p className="settings-status" role="status">
        {saved ? 'Key saved.' : 'No key saved.'}
      </p>
      {keyStatus?.error && (
        <p className="settings-error" role="alert">
          {keyStatus.error}
        </p>
      )}
      {showInput ? (
        <form className="settings-row" onSubmit={save}>
          <label htmlFor={inputId} className="visually-hidden">
            API key
          </label>
          <input
            id={inputId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            placeholder={KEY_HELP[connection]?.placeholder ?? 'Paste your key'}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
          />
          <button type="submit" className="button-primary" disabled={busy || !draft.trim()}>
            {saved ? 'Replace key' : 'Save key'}
          </button>
          {editing && (
            <button
              type="button"
              onClick={() => {
                setEditing(false)
                setDraft('')
              }}
            >
              Cancel
            </button>
          )}
        </form>
      ) : (
        <div className="settings-row">
          <button
            type="button"
            onClick={() => {
              setEditing(true)
            }}
          >
            Replace key
          </button>
          <button
            type="button"
            className="button-danger"
            disabled={busy}
            onClick={() => {
              void run(() =>
                connection === ANTHROPIC_API ? api.apiKey.clear() : api.apiKey.clear(connection),
              )
            }}
          >
            Remove key
          </button>
        </div>
      )}
      <p className="settings-hint">
        The key is encrypted by Windows and can&apos;t be viewed again.
      </p>
    </section>
  )
}

function ModelSection({ connection }: { connection: ConnectionId }): React.JSX.Element {
  const selectId = useId()
  const [error, setError] = useState<string | null>(null)
  const models = useProviderModels(connection)
  const choice = models.choice
  if (!choice) return <section className="settings-section">Loading…</section>
  return (
    <section className="settings-section">
      <h3>
        <label htmlFor={selectId}>Model</label>
      </h3>
      <select
        id={selectId}
        value={choice.selected ?? ''}
        onChange={(event) => {
          setError(null)
          void models.select(event.target.value).then((saved) => {
            if (!saved) setError('Could not change the model.')
          })
        }}
      >
        {choice.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

/** A non-Anthropic API-key connection's key: the app holds only Anthropic's status, so this loads its own. */
function ConnectionKey({ info }: { info: ConnectionInfo }): React.JSX.Element {
  const api = useApi()
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null)
  useEffect(() => {
    let live = true
    api.apiKey.status(info.id).then(
      (status) => {
        if (live) setKeyStatus(status)
      },
      () => {
        if (live) setKeyStatus({ saved: false, error: 'The saved API key cannot be read.' })
      },
    )
    return () => {
      live = false
    }
  }, [api, info.id])
  return (
    <ApiKeySection
      keyStatus={keyStatus}
      onKeyStatus={setKeyStatus}
      connection={info.id}
      title={`${info.title} key`}
    />
  )
}

/** One word for the card: where this connection stands when it is not the one in use. */
function standing(row: ConnectionRow): string {
  if (row.ready) return 'Ready'
  switch (row.info.capabilities.authKind) {
    case 'api-key':
      return 'Needs a key'
    case 'runtime-login':
      return 'Not signed in'
    case 'local':
      return 'Not running'
    default:
      return 'Not ready'
  }
}

function ConfirmRemove({
  info,
  hasKey,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  info: ConnectionInfo
  hasKey: boolean
  busy: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const titleId = useId()
  const textId = useId()
  return (
    <div className="modal-backdrop">
      <div
        className="confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={textId}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault()
            event.stopPropagation()
            onCancel()
          }
        }}
      >
        <h2 id={titleId}>
          Remove <bdi>{info.title}</bdi>?
        </h2>
        <p id={textId}>
          It leaves your list of connections. Your chat history for it stays on this PC
          {hasKey ? ', but its saved API key is deleted' : ''}. You can add it again later.
        </p>
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <div className="approval-actions">
          <button
            type="button"
            className="button-secondary"
            ref={(element) => element?.focus()}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="button-danger" disabled={busy} onClick={onConfirm}>
            Remove connection
          </button>
        </div>
      </div>
    </div>
  )
}

function PersonalUseToggle(): React.JSX.Element {
  const api = useApi()
  const overview = useConnectionOverview()
  const mounted = useMounted()
  const inputId = useId()
  const [error, setError] = useState<string | null>(null)
  const show = overview.state?.showPersonalUse ?? true
  return (
    <div className="personal-use">
      <label htmlFor={inputId} className="personal-use-label">
        <input
          id={inputId}
          type="checkbox"
          checked={show}
          disabled={!overview.state}
          onChange={(event) => {
            setError(null)
            api.connections.setShowPersonalUse(event.target.checked).then(
              (state) => {
                overview.applyState(state)
                overview.refresh({ relist: true })
              },
              (failure: unknown) => {
                if (mounted.current)
                  setError(
                    failure instanceof Error && failure.message
                      ? failure.message.replace(
                          /^Error invoking remote method '[^']*': (Error: )?/,
                          '',
                        )
                      : 'Could not change this setting.',
                  )
              },
            )
          }}
        />
        Show personal-use connections
      </label>
      <p className="settings-hint">
        Anthropic’s terms require approval before another app offers Claude.ai sign-in. Keep this on
        only for your own use, and turn it off in a copy you share with other people.
      </p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

export function AccountsSection(props: SettingsPanelProps): React.JSX.Element {
  const api = useApi()
  const overview = useConnectionOverview()
  const mounted = useMounted()
  const current = props.provider?.provider ?? overview.state?.current ?? DEFAULT_CONNECTION
  const [busy, setBusy] = useState<ConnectionId | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ConnectionRow | null>(null)
  const [removeError, setRemoveError] = useState<string | null>(null)
  const cards = overview.rows.filter((row) => row.configured || row.info.id === current)

  const switchTo = async (id: ConnectionId): Promise<void> => {
    setBusy(id)
    setError(null)
    try {
      props.onProvider?.(await props.onSwitchProvider(id))
      overview.refresh()
    } catch {
      if (mounted.current) setError('Provider request failed. Try again.')
    } finally {
      if (mounted.current) setBusy(null)
    }
  }
  const remove = async (row: ConnectionRow): Promise<void> => {
    setBusy(row.info.id)
    setRemoveError(null)
    try {
      // Its key goes with it; chat history is never touched.
      if (row.keySaved) await api.apiKey.clear(row.info.id)
      overview.applyState(await api.connections.remove(row.info.id))
      overview.refresh()
      if (mounted.current) setRemoving(null)
    } catch {
      if (mounted.current) setRemoveError('Could not remove this connection. Try again.')
    } finally {
      if (mounted.current) setBusy(null)
    }
  }

  return (
    <>
      <section className="settings-section" aria-labelledby="accounts-title">
        <div className="settings-row">
          <h3 id="accounts-title">Accounts &amp; providers</h3>
          {props.onAddConnection && (
            <button
              type="button"
              className="button-primary"
              onClick={() => {
                props.onAddConnection?.()
              }}
            >
              Add connection
            </button>
          )}
        </div>
        <p className="settings-hint">
          Each connection keeps its own chat history. Switching connection ends the current reply.
        </p>
        {error && (
          <p className="settings-error" role="alert">
            {error}
          </p>
        )}
        <ul className="connection-cards" aria-label="Connections">
          {cards.map((row) => {
            const { info } = row
            const isCurrent = info.id === current
            const kind = info.capabilities.authKind
            return (
              <li key={info.id} className="connection-card" data-current={isCurrent || undefined}>
                <div className="connection-card-head">
                  <h4>{info.title}</h4>
                  {isCurrent ? (
                    <span className="chip chip-ok">In use</span>
                  ) : (
                    <span className={row.ready ? 'chip chip-ok' : 'chip chip-off'}>
                      {standing(row)}
                    </span>
                  )}
                </div>
                <p className="settings-hint">{info.description}</p>
                {isCurrent ? (
                  <>
                    {(kind === 'runtime-login' || kind === 'local') && (
                      <ProviderPanel
                        connection={info}
                        status={props.provider ?? null}
                        onStatus={(status) => {
                          props.onProvider?.(status)
                          overview.refresh()
                        }}
                      />
                    )}
                    {kind === 'api-key' && (
                      <>
                        {info.id === ANTHROPIC_API ? (
                          <ApiKeySection
                            keyStatus={props.keyStatus}
                            onKeyStatus={props.onKeyStatus}
                          />
                        ) : (
                          <ConnectionKey info={info} />
                        )}
                      </>
                    )}
                    {info.capabilities.reportsUsage ? (
                      <UsageSection key={info.id} provider={info.id} />
                    ) : (
                      (info.capabilities.listsModels || info.id === ANTHROPIC_API) && (
                        <ModelSection connection={info.id} />
                      )
                    )}
                  </>
                ) : (
                  <div className="settings-row">
                    {row.ready ? (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          void switchTo(info.id)
                        }}
                      >
                        Use {info.title}
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={!props.onAddConnection}
                        onClick={() => {
                          props.onAddConnection?.(info.id)
                        }}
                      >
                        Set up {info.title}
                      </button>
                    )}
                  </div>
                )}
                <div className="settings-row connection-card-foot">
                  <button
                    type="button"
                    className="button-danger"
                    disabled={isCurrent || busy !== null}
                    aria-label={`Remove ${info.title}`}
                    aria-describedby={isCurrent ? `${info.id}-remove-hint` : undefined}
                    onClick={() => {
                      setRemoveError(null)
                      setRemoving(row)
                    }}
                  >
                    Remove
                  </button>
                  {isCurrent && (
                    <small id={`${info.id}-remove-hint`} className="settings-hint">
                      Switch to another connection to remove this one.
                    </small>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
        <PersonalUseToggle />
      </section>
      {removing && (
        <ConfirmRemove
          info={removing.info}
          hasKey={Boolean(removing.keySaved)}
          busy={busy !== null}
          error={removeError}
          onCancel={() => {
            setRemoving(null)
          }}
          onConfirm={() => {
            void remove(removing)
          }}
        />
      )}
    </>
  )
}
