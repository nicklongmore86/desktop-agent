import { join } from 'node:path'
import type { ApprovalPrompt, AuditStatus, ChatEvent } from '../shared/ipc'
import { createAgent, createClaudeClient } from './agent'
import { ChatSession } from './chat/session'
import { AuditLog, GrantStore, PathGuard } from './permissions'
import { createApiKeyStore, type SafeStorage } from './secrets'
import { createConversationStore } from './storage/conversation-store'
import { openSettingsStore } from './storage/settings-store'
import { createTools } from './tools'

export interface AppServiceDeps {
  userData: string
  safeStorage: SafeStorage
  /** Moves a path to the Recycle Bin: Electron's shell.trashItem. */
  trash: (path: string) => Promise<void>
  emit: (event: ChatEvent) => void
  promptApproval: (prompt: ApprovalPrompt) => void
  onAuditStatus: (status: AuditStatus) => void
}

/** Builds the key store, grants, guard, audit log, tools, settings and chat session. */
export async function createAppServices(deps: AppServiceDeps) {
  const { userData } = deps
  const apiKey = createApiKeyStore({ userDataPath: userData, safeStorage: deps.safeStorage })
  const grants = await GrantStore.open(join(userData, 'grants.json'), {
    protectedPaths: [userData],
  })
  const guard = new PathGuard({ roots: () => grants.list(), protectedPaths: [userData] })

  let audit: AuditLog | null = null
  const auditStatus = (): AuditStatus => ({
    healthy: audit?.healthy ?? true,
    path: join(userData, 'audit.jsonl'),
  })
  const reportAudit = (): void => {
    deps.onAuditStatus(auditStatus())
  }
  audit = new AuditLog(auditStatus().path, {
    onError: (error) => {
      console.error('audit log write failed', error)
      reportAudit()
    },
  })
  const tools = createTools({
    guard,
    audit,
    trash: deps.trash,
    onAuditFailure: reportAudit,
  })

  const settings = await openSettingsStore(join(userData, 'settings.json'))

  const chat = new ChatSession({
    store: createConversationStore(join(userData, 'conversation.json')),
    async createRunner() {
      let key: string | null
      try {
        key = await apiKey.get()
      } catch (error) {
        return {
          ok: false,
          code: 'key_unreadable',
          message: error instanceof Error ? error.message : 'The saved API key cannot be read.',
        }
      }
      if (!key)
        return { ok: false, code: 'no_api_key', message: 'Add your Anthropic API key in Settings.' }
      return {
        ok: true,
        runner: createAgent({ client: createClaudeClient(key), tools, model: settings.model }),
      }
    },
    emit: (event) => {
      deps.emit(event)
      // A run is when audit entries get written; refresh the warning afterwards.
      if (event.type === 'run_finished') reportAudit()
    },
    promptApproval: deps.promptApproval,
    onSaveError: (error) => {
      console.error('could not save the conversation', error)
    },
  })
  await chat.init()

  return { apiKey, grants, settings, chat, auditStatus }
}
