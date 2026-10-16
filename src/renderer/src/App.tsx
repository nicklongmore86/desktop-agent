import { useEffect, useRef, useState } from 'react'
import type {
  ApiKeyStatus,
  AppInfo,
  AuditStatus,
  GrantsState,
  ProviderStatus,
  ProviderId,
} from '../../shared/ipc'
import { useApi } from './api'
import { ApprovalCard } from './components/ApprovalCard'
import { ChatView } from './components/ChatView'
import { ErrorBoundary } from './components/ErrorBoundary'
import { SettingsDialog } from './components/SettingsDialog'
import type { OpenSettings, SettingsSection } from './open-settings'
import { useTheme } from './theme'
import { useChat } from './use-chat'
import { useShortcuts } from './use-shortcuts'

const PROVIDER_NAMES: Record<ProviderId, string> = {
  'codex-subscription': 'Codex · ChatGPT',
  'claude-subscription': 'Claude · Subscription',
  'anthropic-api': 'Claude · API',
}

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
        {!hasGrants && <li>Grant at least one folder, so the agent can work with your files.</li>}
      </ul>
      <button
        type="button"
        className="button-primary"
        onClick={() => {
          onOpenSettings()
        }}
      >
        Open Settings
      </button>
    </div>
  )
}

export function App(): React.JSX.Element {
  const api = useApi()
  const chat = useChat()
  // Loads the saved theme and applies it; Settings reads and changes it with useTheme() too.
  useTheme()
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus | null>(null)
  const [grants, setGrants] = useState<GrantsState | null>(null)
  const [provider, setProvider] = useState<ProviderStatus | null>(null)
  const [audit, setAudit] = useState<AuditStatus | null>(null)

  useEffect(() => {
    const report = (what: string) => (error: unknown) => {
      console.error(`${what} failed`, error)
    }
    api.provider.get().then((status) => {
      setProvider((current) => current ?? status)
    }, report('provider.get'))
    api.getAppInfo().then(setAppInfo, report('getAppInfo'))
    api.apiKey.status().then(setKeyStatus, report('apiKey.status'))
    api.grants.list().then(setGrants, report('grants.list'))
    api.audit.status().then(setAudit, report('audit.status'))
    return api.onAuditStatus(setAudit)
  }, [api])

  const loaded = keyStatus !== null && grants !== null
  const keySaved = keyStatus?.saved ?? false
  const hasGrants = (grants?.roots.length ?? 0) > 0
  const openSettings: OpenSettings = (section = 'accounts') => {
    setSettingsSection(section)
  }
  const composerRef = useRef<HTMLTextAreaElement>(null)
  const [approval, ...queued] = chat.state.approvals
  useShortcuts(
    {
      newChat: () => {
        if (chat.state.switching) return
        setSettingsSection(null)
        void chat.newChat()
      },
      openSettings: () => {
        openSettings()
      },
      focusComposer: () => {
        setSettingsSection(null)
        // The message box mounts when the chat view is showing.
        requestAnimationFrame(() => composerRef.current?.focus())
      },
    },
    approval !== undefined,
  )
  const providerName = provider ? PROVIDER_NAMES[provider.provider] : 'Loading provider…'
  const switchProvider = async (next: ProviderId): Promise<void> => {
    try {
      setProvider(await chat.switchProvider(next))
    } catch {
      setProvider((current) =>
        current
          ? {
              ...current,
              state: 'error',
              message: 'Could not switch provider. Open Settings to check the connection.',
            }
          : current,
      )
    }
  }

  return (
    <div className="app">
      <aside inert={settingsSection !== null} className="workspace-sidebar" aria-label="Workspace">
        <div className="workspace-brand">
          <span className="brand-mark" aria-hidden="true">
            D
          </span>
          <strong>Desktop Agent</strong>
        </div>
        <button
          className="sidebar-new"
          type="button"
          disabled={chat.state.switching}
          onClick={() => {
            setSettingsSection(null)
            void chat.newChat()
          }}
        >
          New chat
        </button>
        <div className="sidebar-section sidebar-folders">
          <span className="sidebar-label">Folder access</span>
          {grants?.roots.length ? (
            <ul>
              {grants.roots.map((root) => (
                <li key={root}>
                  <span aria-hidden="true">▱</span>
                  <span className="folder-path">{root}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="sidebar-hint">No folders granted</p>
          )}
          <button
            type="button"
            onClick={() => {
              openSettings('folders')
            }}
          >
            Manage folders
          </button>
        </div>
        <div className="sidebar-footer">
          <p>Changes require your approval.</p>
          <button
            type="button"
            onClick={() => {
              openSettings()
            }}
          >
            Settings
          </button>
          <span className="app-version">{appInfo ? `v${appInfo.version}` : '…'}</span>
        </div>
      </aside>
      <main inert={settingsSection !== null} className="workspace-main">
        <header className="app-header">
          <div>
            <h1>Workspace chat</h1>
            <span className="header-subtitle">
              {chat.state.switching ? 'Switching provider…' : providerName}
            </span>
          </div>
          <nav className="app-nav">
            <button
              type="button"
              className="mobile-new"
              aria-label="Start new chat"
              disabled={chat.state.switching}
              onClick={() => {
                setSettingsSection(null)
                void chat.newChat()
              }}
            >
              ＋
            </button>
            <button
              type="button"
              onClick={() => {
                openSettings()
              }}
            >
              Preferences
            </button>
          </nav>
        </header>

        {audit && !audit.healthy && (
          <div className="banner banner-warning" role="alert">
            <strong>Audit logging is failing.</strong> Tool calls still run, but are not being
            recorded in <code>{audit.path}</code>.
          </div>
        )}

        <ErrorBoundary onReset={chat.newChat} resetLabel="Start a new chat">
          <ChatView
            state={chat.state}
            providerName={providerName}
            grantedFolders={grants?.roots.length ?? 0}
            onSend={chat.send}
            onStop={chat.stop}
            onNewChat={chat.newChat}
            onDismissBanner={chat.dismissBanner}
            onDismissStorageWarning={chat.dismissStorageWarning}
            onOpenSettings={openSettings}
            provider={provider}
            providerNames={PROVIDER_NAMES}
            onSwitchProvider={switchProvider}
            composerRef={composerRef}
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
                  {provider.message}{' '}
                  <button
                    onClick={() => {
                      openSettings()
                    }}
                  >
                    Open Settings
                  </button>
                </div>
              ) : undefined
            }
          />
        </ErrorBoundary>
      </main>

      {settingsSection && (
        <SettingsDialog
          key={settingsSection}
          initialSection={settingsSection}
          suspended={Boolean(approval)}
          onClose={() => {
            setSettingsSection(null)
          }}
          appInfo={appInfo}
          provider={provider}
          onProvider={setProvider}
          onSwitchProvider={chat.switchProvider}
          keyStatus={keyStatus}
          onKeyStatus={setKeyStatus}
          grants={grants}
          onGrants={setGrants}
          audit={audit}
        />
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
