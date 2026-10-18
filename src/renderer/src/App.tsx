import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ApiKeyStatus,
  AppInfo,
  AuditStatus,
  GrantsState,
  ProviderStatus,
} from '../../shared/ipc'
import {
  CHATGPT_PLAN,
  CODEX_SUBSCRIPTION,
  type ConnectionId,
  type ConnectionInfo,
} from '../../shared/ipc-connections'
import { useApi } from './api'
import { ApprovalCard } from './components/ApprovalCard'
import { ChatView } from './components/ChatView'
import { CommandBar } from './components/CommandBar'
import {
  connectionOf,
  ConnectionOverviewProvider,
  ConnectionsProvider,
  useConnectionOverview,
  useConnections,
} from './connections'
import { plainText } from './plain-text'
import { SwitchQueue } from './switch-queue'
import { ConnectionWizard } from './components/connections/ConnectionWizard'
import { ErrorBoundary } from './components/ErrorBoundary'
import { planNoticeKey, SWITCH_BANNER_KEY, useFlag } from './components/chatgpt-plan/plan-flags'
import { PlanNotice } from './components/chatgpt-plan/PlanNotice'
import { PlanSwitchBanner } from './components/chatgpt-plan/PlanSwitchBanner'
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

function SetupGuide({
  connection,
  keySaved,
  hasGrants,
  onOpenSettings,
}: {
  connection: ConnectionInfo
  keySaved: boolean
  hasGrants: boolean
  onOpenSettings: () => void
}): React.JSX.Element {
  const name = connection.vendor === 'anthropic' ? 'Claude' : connection.shortLabel
  return (
    <div className="setup-guide" role="note" aria-label="Finish setting up">
      <strong>Finish setting up in Settings:</strong>
      <ul>
        {!keySaved && <li>{`Add your ${connection.title} key, so ${name} can answer.`}</li>}
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
  return (
    <ConnectionsProvider>
      <ConnectionOverviewProvider>
        <AppWindow />
      </ConnectionOverviewProvider>
    </ConnectionsProvider>
  )
}

function AppWindow(): React.JSX.Element {
  const api = useApi()
  const chat = useChat()
  const connections = useConnections()
  const overview = useConnectionOverview()
  /** Every change of connection waits in this line (see switch-queue.ts). */
  const [switchQueue] = useState(() => new SwitchQueue())
  // Loads the saved theme and applies it; Settings reads and changes it with useTheme() too.
  useTheme()
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null)
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null)
  /** The current API-key connection's key status, tagged with the connection it is for. */
  const [keyState, setKeyState] = useState<{ id: ConnectionId; status: ApiKeyStatus } | null>(null)
  const [grants, setGrants] = useState<GrantsState | null>(null)
  const [provider, setProvider] = useState<ProviderStatus | null>(null)
  const [audit, setAudit] = useState<AuditStatus | null>(null)
  /** The Add connection flow (first run, the composer picker, Settings), or null when closed. */
  const [wizard, setWizard] = useState<{ startAt: ConnectionId | null; firstRun: boolean } | null>(
    null,
  )
  const [firstRunChecked, setFirstRunChecked] = useState(false)
  // ChatGPT · Plan: the one-time notice after its first sign-in, and the Codex users' invitation.
  const [planNoticeSeen, markPlanNoticeSeen] = useFlag(planNoticeKey(CHATGPT_PLAN))
  const [switchBannerDismissed, dismissSwitchBanner] = useFlag(SWITCH_BANNER_KEY)
  // Waits for the wizard and Settings to close, so it never stacks on another dialog.
  const showPlanNotice =
    provider?.provider === CHATGPT_PLAN &&
    provider.state === 'ready' &&
    !planNoticeSeen &&
    settingsSection === null &&
    wizard === null
  const planReady = overview.rows.some((row) => row.info.id === CHATGPT_PLAN && row.ready)
  const showSwitchBanner =
    provider?.provider === CODEX_SUBSCRIPTION &&
    provider.state === 'ready' &&
    !switchBannerDismissed &&
    !planReady

  useEffect(() => {
    const report = (what: string) => (error: unknown) => {
      console.error(`${what} failed`, error)
    }
    api.provider.get().then((status) => {
      setProvider((current) => current ?? status)
    }, report('provider.get'))
    api.getAppInfo().then(setAppInfo, report('getAppInfo'))
    api.grants.list().then(setGrants, report('grants.list'))
    api.audit.status().then(setAudit, report('audit.status'))
    return api.onAuditStatus(setAudit)
  }, [api])

  // Nothing is ready to chat with: open the wizard once per launch, when the checks are in.
  if (!firstRunChecked && overview.loaded) {
    setFirstRunChecked(true)
    if (!overview.rows.some((row) => row.ready)) setWizard({ startAt: null, firstRun: true })
  }
  // The checks behind the picker and the cards follow the connection chats go to.
  const refreshOverview = overview.refresh
  const providerId = provider?.provider
  const providerState = provider?.state
  useEffect(() => {
    if (providerId) refreshOverview()
  }, [providerId, providerState, refreshOverview])

  const connection = connectionOf(connections, provider?.provider)
  const keyConnection = connection?.capabilities.authKind === 'api-key' ? connection.id : null
  useEffect(() => {
    if (!keyConnection) return
    let live = true
    api.apiKey.status(keyConnection).then(
      (status) => {
        if (live) setKeyState({ id: keyConnection, status })
      },
      (error: unknown) => {
        console.error('apiKey.status failed', error)
      },
    )
    return () => {
      live = false
    }
  }, [api, keyConnection])
  const keyStatus = keyState && keyState.id === keyConnection ? keyState.status : null
  const setKeyStatus = (status: ApiKeyStatus): void => {
    if (keyConnection) setKeyState({ id: keyConnection, status })
  }
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
    approval !== undefined || listDialog || wizard !== null || showPlanNotice,
  )
  useViewModeHotkey(
    () => {
      if (!chat.state.switching) changeView(view === 'chat' ? 'command' : 'chat')
    },
    approval !== undefined ||
      settingsSection !== null ||
      listDialog ||
      wizard !== null ||
      showPlanNotice,
  )
  /** A choice the user made: it waits its turn behind any switch in flight, and counts as intent. */
  const userSwitch = <T,>(task: () => Promise<T>): Promise<T> => {
    switchQueue.choose()
    return switchQueue.run(task)
  }
  const switchForWizard = async (next: ConnectionId): Promise<ProviderStatus> => {
    const status = await chat.switchProvider(next)
    setProvider(status)
    return status
  }
  const closeWizard = (): void => {
    setWizard(null)
    if (keyConnection) api.apiKey.status(keyConnection).then(setKeyStatus, () => {})
    overview.refresh()
  }
  // The picker lists what is ready to use, and always the connection in use.
  const pickerConnections = overview.loaded
    ? overview.rows
        .filter((row) => row.ready || row.info.id === provider?.provider)
        .map((row) => row.info)
    : (connections ?? []).filter((info) => info.id === provider?.provider)
  const providerName = connectionOf(connections, provider?.provider)?.label ?? 'Loading provider…'
  const switchProvider = async (next: ConnectionId): Promise<void> => {
    try {
      setProvider(await userSwitch(() => chat.switchProvider(next)))
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
        inert={settingsSection !== null || wizard !== null || showPlanNotice}
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
                void userSwitch(() => chat.openOther(ref)).then((status) => {
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
              git: <GitTab grants={grants} />,
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

        {showSwitchBanner && (
          <PlanSwitchBanner
            onSetUp={() => {
              setWizard({ startAt: CHATGPT_PLAN, firstRun: false })
            }}
            onDismiss={dismissSwitchBanner}
          />
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
            connections={pickerConnections}
            onSwitchProvider={switchProvider}
            onManageConnections={() => {
              setWizard({ startAt: null, firstRun: false })
            }}
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
              loaded && connection && keyConnection && (!keySaved || !hasGrants) ? (
                <SetupGuide
                  connection={connection}
                  keySaved={keySaved}
                  hasGrants={hasGrants}
                  onOpenSettings={openSettings}
                />
              ) : provider &&
                provider.state !== 'ready' &&
                // An API-key connection without a key is covered by the guide above.
                !(keyConnection && !keySaved) ? (
                <div role="note" className="setup-guide">
                  {plainText(provider.message)}{' '}
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
          suspended={Boolean(approval) || wizard !== null}
          onAddConnection={(startAt) => {
            setWizard({ startAt: startAt ?? null, firstRun: false })
          }}
          onClose={() => {
            setSettingsSection(null)
          }}
          appInfo={appInfo}
          provider={provider}
          onProvider={setProvider}
          onSwitchProvider={(next) => userSwitch(() => chat.switchProvider(next))}
          keyStatus={keyStatus}
          onKeyStatus={setKeyStatus}
          grants={grants}
          onGrants={setGrants}
          audit={audit}
        />
      )}

      {wizard && (
        <ConnectionWizard
          suspended={Boolean(approval)}
          firstRun={wizard.firstRun}
          startAt={wizard.startAt}
          grants={grants}
          onGrants={setGrants}
          onProvider={setProvider}
          queue={switchQueue}
          onSwitchProvider={switchForWizard}
          onClose={closeWizard}
        />
      )}

      {showPlanNotice && (
        <PlanNotice suspended={Boolean(approval)} onDismiss={markPlanNoticeSeen} />
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
