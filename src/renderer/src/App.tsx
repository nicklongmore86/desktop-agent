import { useEffect, useState } from 'react'
import type {
  ApiKeyStatus,
  AppInfo,
  AuditStatus,
  GrantsState,
  ModelSettings,
  ProviderStatus,
} from '../../shared/ipc'
import { useApi } from './api'
import { ApprovalCard } from './components/ApprovalCard'
import { ChatView } from './components/ChatView'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SettingsPanel } from './components/SettingsPanel'
import { useChat } from './use-chat'

function SetupGuide({
  keySaved,
  hasGrants,
  onOpenSettings,
}: {
  keySaved: boolean
  hasGrants: boolean
  onOpenSettings: () => void
}): React.JSX.Element {
  return (
    <div className="setup-guide" role="note" aria-label="Finish setting up">
      <strong>Finish setting up in Settings:</strong>
      <ul>
        {!keySaved && <li>Add your Anthropic API key, so Claude can answer.</li>}
        {!hasGrants && <li>Grant at least one folder, so Claude can work with your files.</li>}
      </ul>
      <button type="button" className="button-primary" onClick={onOpenSettings}>
        Open Settings
      </button>
    </div>
  )
}

export function App(): React.JSX.Element {
  const api = useApi()
  const chat = useChat()
  const [view, setView] = useState<'chat' | 'settings'>('chat')
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null)
  const [grants, setGrants] = useState<GrantsState | null>(null)
  const [model, setModel] = useState<ModelSettings | null>(null)
  const [provider, setProvider] = useState<ProviderStatus | null>(null)
  const [audit, setAudit] = useState<AuditStatus | null>(null)

  useEffect(() => {
    const report = (what: string) => (error: unknown) => {
      console.error(`${what} failed`, error)
    }
    api.provider.get().then(setProvider, report('provider.get'))
    api.getAppInfo().then(setAppInfo, report('getAppInfo'))
    api.apiKey.status().then(setKeyStatus, report('apiKey.status'))
    api.grants.list().then(setGrants, report('grants.list'))
    api.model.get().then(setModel, report('model.get'))
    api.audit.status().then(setAudit, report('audit.status'))
    return api.onAuditStatus(setAudit)
  }, [api])

  const loaded = keyStatus !== null && grants !== null
  const keySaved = keyStatus?.saved ?? false
  const hasGrants = (grants?.roots.length ?? 0) > 0
  const openSettings = (): void => {
    setView('settings')
  }
  const [approval, ...queued] = chat.state.approvals

  return (
    <div className="app">
      <header className="app-header">
        <h1>Desktop Agent</h1>
        <span className="app-version">{appInfo ? `v${appInfo.version}` : '…'}</span>
        <nav className="app-nav">
          {view === 'chat' ? (
            <button type="button" onClick={openSettings}>
              Settings
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setView('chat')
              }}
            >
              Back to chat
            </button>
          )}
        </nav>
      </header>

      {audit && !audit.healthy && (
        <div className="banner banner-warning" role="alert">
          <strong>Audit logging is failing.</strong> Tool calls still run, but are not being
          recorded in <code>{audit.path}</code>.
        </div>
      )}

      {view === 'settings' ? (
        <SettingsPanel
          provider={provider}
          onProvider={setProvider}
          keyStatus={keyStatus}
          onKeyStatus={setKeyStatus}
          grants={grants}
          onGrants={setGrants}
          model={model}
          onModel={setModel}
          audit={audit}
        />
      ) : (
        <ErrorBoundary onReset={chat.newChat} resetLabel="Start a new chat">
          <ChatView
            state={chat.state}
            onSend={chat.send}
            onStop={chat.stop}
            onNewChat={chat.newChat}
            onDismissBanner={chat.dismissBanner}
            onDismissStorageWarning={chat.dismissStorageWarning}
            onOpenSettings={openSettings}
            notice={
              loaded && provider?.provider === 'anthropic-api' && (!keySaved || !hasGrants) ? (
                <SetupGuide
                  keySaved={keySaved}
                  hasGrants={hasGrants}
                  onOpenSettings={openSettings}
                />
              ) : provider &&
                provider.provider !== 'anthropic-api' &&
                provider.state !== 'ready' ? (
                <div role="note" className="setup-guide">
                  {provider.message} <button onClick={openSettings}>Open Settings</button>
                </div>
              ) : undefined
            }
          />
        </ErrorBoundary>
      )}

      {approval && (
        <ApprovalCard
          key={approval.id}
          prompt={approval}
          queued={queued.length}
          onRespond={chat.respond}
        />
      )}
    </div>
  )
}
