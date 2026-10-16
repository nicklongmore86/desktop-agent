import { useCallback, useEffect, useRef, useState } from 'react'
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
import { CommandBar } from './components/CommandBar'
import { ErrorBoundary } from './components/ErrorBoundary'
import { FileReferencesProvider } from './components/files/file-references'
import { SettingsDialog } from './components/SettingsDialog'
import { AppHeader } from './components/shell/AppHeader'
import { AppShell, type ShellHandle } from './components/shell/AppShell'
import { ChatsPane } from './components/shell/ChatsPane'
import { LeftSidebar } from './components/shell/LeftSidebar'
import { RightPanel } from './components/shell/RightPanel'
import { FilesTab } from './components/shell/tabs/FilesTab'
import { GitTab } from './components/shell/tabs/GitTab'
import { ViewModeToggle, type ViewMode } from './components/ViewModeToggle'
import type { OpenSettings, SettingsSection } from './open-settings'
import { useTheme } from './theme'
import { useChat } from './use-chat'
import { useChatView } from './use-chat-view'
import { useCommandLine } from './use-command-line'
import { useShortcuts, useViewModeHotkey } from './use-shortcuts'

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
  const commandRef = useRef<HTMLInputElement>(null)
  const [view, setView] = useChatView(chat.state.history.activeId, chat.state.switching)
  const commandLine = useCommandLine(grants?.roots ?? [])
  const [commandSending, setCommandSending] = useState(false)
  const focusInput = (mode: ViewMode): void => {
    // The input mounts (or shows) once the view has rendered.
    requestAnimationFrame(() => {
      if (mode === 'command') commandRef.current?.focus()
      else composerRef.current?.focus()
    })
  }
  const changeView = (mode: ViewMode): void => {
    setView(mode)
    focusInput(mode)
  }
  const runCommand = async (): Promise<void> => {
    const command = commandLine.draft.trim()
    const cwd = commandLine.cwd
    if (!command || !cwd || chat.state.running || chat.state.switching || commandSending) return
    setCommandSending(true)
    try {
      commandLine.remember(command)
      if (await chat.runCommand(command, cwd)) commandLine.setDraft('')
    } finally {
      setCommandSending(false)
    }
  }
  const [approval, ...queued] = chat.state.approvals
  const shell = useRef<ShellHandle>(null)
  // A chat-list dialog (delete, fork, project) is open: shortcuts wait for it.
  const [listDialog, setListDialog] = useState(false)
  const onListDialog = useCallback((open: boolean) => {
    setListDialog(open)
  }, [])
  const startNewChat = (): void => {
    if (chat.state.switching) return
    setSettingsSection(null)
    shell.current?.closeDrawer()
    void chat.newChat()
  }
  useShortcuts(
    {
      newChat: startNewChat,
      openSettings: () => {
        openSettings()
      },
      focusComposer: () => {
        setSettingsSection(null)
        // The message box (or command line) mounts when the chat view is showing.
        focusInput(view)
      },
    },
    approval !== undefined || listDialog,
  )
  useViewModeHotkey(
    () => {
      if (!chat.state.switching) changeView(view === 'chat' ? 'command' : 'chat')
    },
    approval !== undefined || settingsSection !== null || listDialog,
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
    <FileReferencesProvider>
      <AppShell
        shellRef={shell}
        inert={settingsSection !== null}
        suspended={Boolean(approval)}
        blocked={listDialog}
        left={(variant) => (
          <LeftSidebar
            variant={variant}
            appInfo={appInfo}
            onOpenSettings={() => {
              openSettings()
            }}
          >
            <ChatsPane
              variant={variant}
              history={chat.state.history}
              switching={chat.state.switching}
              running={chat.state.running}
              provider={provider?.provider ?? null}
              prompts={chat.state.items.flatMap((item) =>
                item.kind === 'user' ? [item.text] : [],
              )}
              suspended={Boolean(approval)}
              onNewChat={startNewChat}
              onOpen={(id) => {
                void chat.openConversation(id)
              }}
              onOpenOther={(ref) => {
                void chat.openOther(ref).then((status) => {
                  if (status) setProvider(status)
                })
              }}
              onRename={chat.renameConversation}
              onDelete={(id) => {
                void chat.deleteConversation(id)
              }}
              onBlocking={onListDialog}
            />
          </LeftSidebar>
        )}
        right={() => (
          <RightPanel
            tabs={{
              files: (
                <FilesTab grants={grants} onGrants={setGrants} onOpenSettings={openSettings} />
              ),
              git: <GitTab />,
            }}
          />
        )}
      >
        <AppHeader
          subtitle={
            chat.state.switchKind === 'provider'
              ? 'Switching provider…'
              : chat.state.switchKind === 'chat'
                ? 'Opening chat…'
                : providerName
          }
          switching={chat.state.switching}
          onNewChat={startNewChat}
          onOpenSettings={() => {
            openSettings()
          }}
          actions={
            <ViewModeToggle view={view} onChange={changeView} disabled={chat.state.switching} />
          }
        />

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
            platform={appInfo?.platform}
            commandBar={
              view === 'command' ? (
                <CommandBar
                  draft={commandLine.draft}
                  onDraft={commandLine.setDraft}
                  inputRef={commandRef}
                  roots={grants?.roots ?? []}
                  cwd={commandLine.cwd}
                  onCwd={commandLine.setCwd}
                  history={commandLine.history}
                  platform={appInfo?.platform}
                  running={chat.state.running}
                  switching={chat.state.switching}
                  sending={commandSending}
                  onSubmit={() => {
                    void runCommand()
                  }}
                  onStop={() => {
                    void chat.stop()
                  }}
                  onOpenSettings={openSettings}
                />
              ) : undefined
            }
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
      </AppShell>

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
    </FileReferencesProvider>
  )
}
