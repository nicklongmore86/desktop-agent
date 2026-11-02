import { randomUUID } from 'node:crypto'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type { AttachmentRef } from '../../shared/attachments'
import type {
  ApprovalOrigin,
  ApprovalPrompt,
  ChatErrorCode,
  ChatRef,
  ChatEvent,
  ChatState,
  HistoryState,
  SendResult,
} from '../../shared/ipc'
import type { ConnectionId } from '../../shared/ipc-connections'
import type {
  AgentEvent,
  AgentTool,
  ApprovalRequest,
  RunOptions,
  RunResult,
  ToolResult,
} from '../agent'
import {
  attachmentsOf,
  withOrigin,
  type AttachmentBlock,
  type ConversationStore,
  type MessageOrigin,
  type StoredMessage,
} from '../storage/conversation-store'
import type { DocumentReader } from '../documents/types'
import type { ConversationHistory } from '../storage/history-store'
import {
  AttachmentPins,
  cachedPdfReading,
  checkAttachments,
  requestedIds,
  toModelConversation,
  unavailableAttachments,
  type AttachmentStoreLike,
  type PdfReading,
} from './attachments'
import { singleLibrary, type ChatLibrary } from './library'
import { toTranscript } from './transcript'
import { userCommandMessage } from './user-command'

/** What a switch opens: a conversation, and what to record once it has loaded. */
interface SwitchTarget {
  /** The chat's home connection and its history (where it is saved). */
  home: ConnectionId
  history: ConversationHistory
  store: ConversationStore
  /** The saved chat's id; null for a new chat. */
  id: string | null
  commit: () => Promise<void>
}

/** One agent run. `createAgent(...)` satisfies this. */
export interface AgentRunner {
  run: (conversation: MessageParam[], options: RunOptions) => Promise<RunResult>
  /**
   * Whether the model can see images, when known before the run. False: attached images
   * are sent as a note only. Absent: they are sent, and the runner strips them if its model
   * turns out not to see images (Codex reads that from its catalog during the run).
   */
  readonly vision?: boolean
  /** The model it asks, when known before the run (recorded as its replies' provenance). */
  readonly model?: string
}

/** Who writes a run's replies, recorded in the chat file's `origin` (display only). */
export interface RunOrigin {
  connection: ConnectionId
  model: string | null
}

export type RunnerResult =
  | { ok: true; runner: AgentRunner; origin?: RunOrigin }
  | { ok: false; code: ChatErrorCode; message: string; resetsAt?: string }

export interface ChatSessionDeps {
  /** The open chat's home history; the open one is loaded by `init`. */
  history: ConversationHistory
  /** `history`'s connection. Default: the library's current connection. */
  home?: ConnectionId
  /** The chat to open: a saved id of `history`, or null for a new chat. Default: its current one. */
  openId?: string | null
  /** Every connection's chats. Default: `history` alone (one connection). */
  library?: ChatLibrary
  /**
   * Builds an agent for the *current* connection, with its key, model and tools: a new
   * one for every run, so nothing provider-specific (Gemini thought signatures, ChatGPT
   * reasoning items) outlives the run or reaches the saved chat.
   */
  createRunner: (signal: AbortSignal) => Promise<RunnerResult>
  /** Streams an event to the renderer. */
  emit: (event: ChatEvent) => void
  /** Shows an approval prompt in the renderer. */
  promptApproval: (prompt: ApprovalPrompt) => void
  newId?: () => string
  /** Persistence failures; the conversation stays in memory. */
  onSaveError?: (error: unknown) => void
  /** The agent's run_shell tool, for commands the user types in the command bar. */
  userShell?: AgentTool
  /** Holds attached files. Without it, sending attachments is refused. */
  attachments?: AttachmentStoreLike
  /** Shared with whatever releases attachment files (see AttachmentPins). */
  pins?: AttachmentPins
  /** Reads PDF attachments for the model. Without it, a PDF is sent as a placeholder. */
  documents?: DocumentReader
}

interface PendingApproval {
  runId: string
  resolve: (approved: boolean) => void
}

interface ActiveRun {
  id: string
  /** Whose run it is, for its approval prompts: a reply, or a typed command. */
  origin: ApprovalOrigin
  controller: AbortController
  done: Promise<void>
}

// Compile-time check that every agent error code is one the UI knows.
type AgentErrorEvent = Extract<AgentEvent, { type: 'error' }>
const toChatCode = (code: AgentErrorEvent['code']): ChatErrorCode => code

/**
 * The main-process side of the chat: owns the current conversation, runs the
 * agent one run at a time, streams its events to the renderer and brokers
 * approvals. Every approval is denied unless the renderer answers its exact
 * random id while the run is still going; stop, new chat, window close or
 * reload and quit all deny whatever is pending.
 *
 * The open chat is separate from the current connection: it is saved to its
 * home connection's history, while each run goes to whatever connection is
 * current (`createRunner`). Opening another conversation, New chat and
 * connection switches all go through `switchTo`: the send slot is reserved and
 * the run stopped (its approvals denied) synchronously, then the switch waits
 * for the run to end (it saves to the conversation it belongs to) before loading
 * the next one. A connection switch with a saved chat open reopens that chat.
 */
export class ChatSession {
  private conversation: StoredMessage[] = []
  /** The open conversation's reply provenance (the chat file's `origin`). */
  private origin: MessageOrigin[] = []
  /** Attachment ids in the open conversation whose stored file is gone. */
  private unavailable: ReadonlySet<string> = new Set()
  private readonly library: ChatLibrary
  /** The open chat's home connection, and its history. */
  private home: ConnectionId
  private history: ConversationHistory
  private store: ConversationStore
  /** The open chat's id, null while it is a new chat that was never saved. */
  private openId: string | null
  private loadError: string | null = null
  private active: ActiveRun | null = null
  private readonly pending = new Map<string, PendingApproval>()
  private readonly newId: () => string
  private readonly pins: AttachmentPins
  private readonly readPdf: PdfReading | null
  /** Bumped by every switch; a run or save from an older generation never touches history. */
  private generation = 0
  /** Loads and switches in flight. While > 0, send() is refused. */
  private resets = 0
  private resetQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ChatSessionDeps) {
    this.newId = deps.newId ?? randomUUID
    this.pins = deps.pins ?? new AttachmentPins()
    this.readPdf = deps.documents ? cachedPdfReading(deps.documents) : null
    this.library = deps.library ?? singleLibrary(deps.history, deps.home)
    this.home = deps.home ?? this.library.connection()
    this.history = deps.history
    if (deps.openId === undefined) {
      this.store = deps.history.current()
      this.openId = deps.history.activeId
    } else {
      this.store = deps.openId === null ? deps.history.draft() : deps.history.open(deps.openId)
      this.openId = deps.openId
    }
  }

  /**
   * Loads the open conversation. Like a switch, it reserves
   * the send slot and runs in the reset queue, so a send cannot start on
   * unloaded history and a late load can never overwrite a later switch.
   */
  init(): Promise<void> {
    this.resets += 1
    const loaded = this.resetQueue.then(async () => {
      try {
        const { messages, error, origin } = await this.store.load()
        const unavailable = await unavailableAttachments(messages, this.deps.attachments)
        this.conversation = messages
        this.origin = origin ?? []
        this.unavailable = unavailable
        this.loadError = error
      } finally {
        this.resets -= 1
      }
    })
    this.resetQueue = loaded.catch(() => {})
    return loaded
  }

  get running(): boolean {
    return this.active !== null
  }

  /** Approval ids still waiting for an answer (for tests and diagnostics). */
  get pendingApprovals(): string[] {
    return [...this.pending.keys()]
  }

  state(): ChatState {
    return {
      items: toTranscript(this.conversation, this.unavailable, this.origin),
      running: this.running,
      loadError: this.loadError,
      history: this.historyState(),
    }
  }

  /** The open chat by home and id; null for a new chat never saved. */
  get openRef(): ChatRef | null {
    const id = this.store.id?.() ?? this.openId
    return id === null ? null : { provider: this.home, id }
  }

  /**
   * The chat list: every connection's chats (`chats`), the open one (`active`), and the
   * current connection's own chats as older renderers read them (`conversations`).
   */
  historyState(): HistoryState {
    const active = this.openRef
    const own = this.library.loaded(this.library.connection())
    return {
      conversations: own?.state().conversations ?? [],
      activeId: active?.id ?? null,
      active,
      chats: this.library.list(),
    }
  }

  /** Every attachment id the open conversation references (still in use, even unsaved). */
  attachmentIds(): string[] {
    return this.conversation.flatMap((message) => attachmentsOf(message).map(({ id }) => id))
  }

  /**
   * Starts a run. Resolves once it has started, not when it finishes (see `idle`).
   * `attachments` are ids the renderer was given (see checkAttachments): only the
   * ids are read, and the saved metadata is the store's. They are pinned before
   * the first await, so a release cannot free them, until the prompt is in the
   * open conversation or the send fails.
   */
  async send(text: unknown, attachments?: unknown): Promise<SendResult> {
    const attaching = Array.isArray(attachments) && attachments.length > 0
    if (typeof text !== 'string' || (!text.trim() && !attaching))
      return { ok: false, code: 'invalid_request', message: 'Type a message first.' }
    if (this.resets > 0)
      return { ok: false, code: 'busy', message: 'Chat is busy. Try again in a moment.' }
    if (this.active)
      return { ok: false, code: 'busy', message: 'Wait for the current reply, or stop it.' }
    const generation = this.generation
    // Claim the slot before awaiting, so two quick sends cannot both start.
    const id = this.newId()
    const controller = new AbortController()
    // A function, not a value: stop() or a New chat can happen at any await below.
    const cancelled = (): boolean => controller.signal.aborted || generation !== this.generation
    let release: () => void = () => {}
    this.active = {
      id,
      origin: 'agent',
      controller,
      done: new Promise((resolve) => {
        release = resolve
      }),
    }

    const unpin = this.pins.pin(requestedIds(attachments) ?? [])
    let checked: Extract<Awaited<ReturnType<typeof checkAttachments>>, { ok: true }>
    let built: RunnerResult
    try {
      // A release already freeing files finishes first, so a freed file reads as gone.
      await this.pins.settled()
      const check = await checkAttachments(attachments, this.deps.attachments)
      if (!check.ok || cancelled()) {
        this.active = null
        release()
        return check.ok
          ? { ok: false, code: 'aborted', message: 'Stopped before the reply started.' }
          : { ok: false, code: 'invalid_request', message: check.message }
      }
      checked = check

      try {
        // Always the current connection's runner, whatever the chat's home.
        built = await this.deps.createRunner(controller.signal)
      } catch {
        built = { ok: false, code: 'internal', message: 'Could not start the agent.' }
      }
      if (!built.ok || cancelled()) {
        this.active = null
        release()
        return built.ok
          ? { ok: false, code: 'aborted', message: 'Stopped before the reply started.' }
          : {
              ok: false,
              code: built.code,
              message: built.message,
              ...(built.resetsAt ? { resetsAt: built.resetsAt } : {}),
            }
      }

      this.conversation = [...this.conversation, promptMessage(text, checked.attachments)]
    } finally {
      // Referenced by the open conversation now (or never will be).
      unpin()
    }
    // A file attached again (same contents, same id) is available again.
    if (checked.attachments.some(({ id }) => this.unavailable.has(id))) {
      const sent = new Set(checked.attachments.map(({ id }) => id))
      this.unavailable = new Set([...this.unavailable].filter((id) => !sent.has(id)))
    }
    this.loadError = null
    await this.persist()
    // The saved history keeps its attachment blocks; the runner gets their text form.
    const stored = this.conversation
    const sent = await toModelConversation(stored, this.deps.attachments, this.unavailable, {
      ...(this.readPdf ? { readPdf: this.readPdf } : {}),
      ...(built.runner.vision !== undefined ? { vision: built.runner.vision } : {}),
    })
    if (cancelled()) {
      this.active = null
      release()
      return { ok: false, code: 'aborted', message: 'Stopped before the reply started.' }
    }
    this.notify({
      type: 'run_started',
      runId: id,
      text,
      ...(checked.attachments.length > 0 ? { attachments: checked.attachments } : {}),
    })
    const run = { runId: id, controller, generation, origin: built.origin ?? null }
    void this.execute(built.runner, run, stored, sent).finally(() => {
      this.denyPending(id)
      this.active = null
      release()
    })
    return { ok: true }
  }

  private async execute(
    runner: AgentRunner,
    run: {
      runId: string
      controller: AbortController
      generation: number
      origin: RunOrigin | null
    },
    stored: StoredMessage[],
    sent: MessageParam[],
  ): Promise<void> {
    const { runId, controller, generation } = run
    // The agent emits approval_requested synchronously right before calling
    // requestApproval, which lets the prompt name its tool call.
    let approvalToolUseId: string | null = null
    let result: RunResult
    try {
      result = await runner.run(sent, {
        signal: controller.signal,
        onEvent: (event) => {
          if (generation !== this.generation || controller.signal.aborted) return
          if (event.type === 'approval_requested') approvalToolUseId = event.id
          this.forward(runId, event)
        },
        requestApproval: (request) => {
          const toolUseId = approvalToolUseId
          approvalToolUseId = null
          return this.requestApproval(runId, controller.signal, toolUseId, request)
        },
      })
    } catch {
      this.notify({
        type: 'error',
        runId,
        code: 'internal',
        message: 'The agent stopped unexpectedly.',
      })
      this.notify({ type: 'run_finished', runId, stopReason: 'internal' })
      return
    }
    // A New chat started meanwhile: this run's history belongs to the old conversation.
    if (generation === this.generation) {
      // A run only ever appends to the history it was given.
      const added = result.conversation.slice(sent.length)
      this.conversation = [...stored, ...added]
      // Its replies were written by the connection the run was built for.
      if (added.length > 0 && run.origin)
        this.origin = withOrigin(
          this.origin,
          stored.length,
          run.origin.connection,
          run.origin.model,
        )
      await this.persist()
    }
    this.notify({ type: 'run_finished', runId, stopReason: result.stopReason })
  }

  private forward(runId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.notify({ type: 'text_delta', runId, turn: event.turn, text: event.text })
        break
      case 'response_discarded':
        this.notify({ type: 'response_discarded', runId, turn: event.turn })
        break
      case 'tool_use':
        this.notify({
          type: 'tool_use',
          runId,
          turn: event.turn,
          id: event.id,
          name: event.name,
          input: event.input,
        })
        break
      case 'tool_result':
        this.notify({
          type: 'tool_result',
          runId,
          id: event.id,
          content: event.result.content,
          isError: event.result.isError === true,
          declined: event.result.declined === true,
        })
        break
      case 'error':
        this.notify({
          type: 'error',
          runId,
          code: toChatCode(event.code),
          message: event.message,
          ...(event.resetsAt ? { resetsAt: event.resetsAt } : {}),
        })
        break
      default:
        // usage, turn_complete and approval_* are not shown; approvals have their own channel.
        break
    }
  }

  private requestApproval(
    runId: string,
    signal: AbortSignal,
    toolUseId: string | null,
    request: ApprovalRequest,
  ): Promise<boolean> {
    if (signal.aborted || this.active?.id !== runId) return Promise.resolve(false)
    const origin = this.active.origin
    const id = this.newId()
    return new Promise<boolean>((resolve) => {
      this.pending.set(id, { runId, resolve })
      try {
        this.deps.promptApproval({
          id,
          runId,
          toolUseId,
          tool: request.tool,
          kind: request.kind,
          summary: request.summary,
          detail: request.detail ?? null,
          origin,
        })
      } catch {
        // The prompt never reached the user, so it can only be a denial.
        const entry = this.pending.get(id)
        if (entry) this.settle(id, entry, false)
      }
    })
  }

  /**
   * Runs a command the user typed in the command bar through `deps.userShell`, the
   * agent's own run_shell tool: the same folder checks, approval prompt, launch and
   * output limits, audited as `origin: 'user-terminal'`. It takes the send slot like a
   * reply, so it is refused while a reply, another command or a switch is in flight,
   * and stop() cancels it (killing the process tree). Its card is saved in the
   * conversation. Resolves once it has started.
   */
  runCommand(command: unknown, cwd: unknown): Promise<SendResult> {
    const shell = this.deps.userShell
    if (!shell)
      return Promise.resolve({
        ok: false,
        code: 'internal',
        message: 'Commands are unavailable.',
      })
    if (typeof command !== 'string' || !command.trim() || typeof cwd !== 'string' || !cwd)
      return Promise.resolve({
        ok: false,
        code: 'invalid_request',
        message: 'Type a command first.',
      })
    if (this.resets > 0)
      return Promise.resolve({
        ok: false,
        code: 'busy',
        message: 'Chat is busy. Try again in a moment.',
      })
    if (this.active)
      return Promise.resolve({
        ok: false,
        code: 'busy',
        message: 'Wait for the current reply or command, or stop it.',
      })
    const generation = this.generation
    const runId = this.newId()
    const id = this.newId()
    const controller = new AbortController()
    let release: () => void = () => {}
    this.active = {
      id: runId,
      origin: 'user-terminal',
      controller,
      done: new Promise((resolve) => {
        release = resolve
      }),
    }
    this.notify({ type: 'command_started', runId, id, command, cwd })
    void this.executeCommand(shell, { runId, id, command, cwd }, controller, generation).finally(
      () => {
        this.denyPending(runId)
        this.active = null
        release()
      },
    )
    return Promise.resolve({ ok: true })
  }

  private async executeCommand(
    shell: AgentTool,
    run: { runId: string; id: string; command: string; cwd: string },
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    const { runId, id, command, cwd } = run
    let result: ToolResult
    try {
      result = await shell.execute(
        { command, cwd },
        {
          signal: controller.signal,
          origin: 'user-terminal',
          requestApproval: (request) => this.requestApproval(runId, controller.signal, id, request),
        },
      )
    } catch {
      result = { content: 'The command could not be run.', isError: true }
    }
    const isError = result.isError === true
    const declined = result.declined === true
    // As for a reply: after a switch, this card belongs to the old conversation.
    if (generation === this.generation) {
      this.conversation = [
        ...this.conversation,
        userCommandMessage({ id, command, cwd, output: result.content, isError, declined }),
      ]
      this.loadError = null
      await this.persist()
    }
    this.notify({ type: 'tool_result', runId, id, content: result.content, isError, declined })
    this.notify({ type: 'run_finished', runId, stopReason: isError ? 'error' : 'end_turn' })
  }

  /**
   * Runs a tool call the user asked for in the app (an attachment's "Copy into folder…"),
   * with this session's approval prompts, audited as `origin: 'user'`. Like a typed
   * command it takes the send slot, so it is refused while a reply, command or switch is
   * in flight, and stop() cancels it (denying its approval). Nothing is added to the
   * conversation. Resolves with the tool's result once it has finished.
   */
  async runUserAction(tool: AgentTool, input: unknown): Promise<ToolResult> {
    if (this.resets > 0 || this.active)
      return {
        content: 'Wait for the current reply or command to finish, or stop it, then try again.',
        isError: true,
      }
    const runId = this.newId()
    const controller = new AbortController()
    let release: () => void = () => {}
    this.active = {
      id: runId,
      origin: 'user',
      controller,
      done: new Promise((resolve) => {
        release = resolve
      }),
    }
    try {
      return await tool.execute(input, {
        signal: controller.signal,
        origin: 'user',
        requestApproval: (request) => this.requestApproval(runId, controller.signal, null, request),
      })
    } catch {
      return { content: 'That could not be done.', isError: true }
    } finally {
      this.denyPending(runId)
      this.active = null
      release()
    }
  }

  /**
   * Answers a pending approval. Only an exact pending id resolves anything,
   * and only `approved === true` approves; everything else is ignored.
   */
  respondApproval(id: unknown, approved: unknown): boolean {
    if (typeof id !== 'string') return false
    const entry = this.pending.get(id)
    if (!entry) return false
    this.settle(id, entry, approved === true)
    return true
  }

  private settle(id: string, entry: PendingApproval, approved: boolean): void {
    this.pending.delete(id)
    entry.resolve(approved)
    this.notify({ type: 'approval_closed', approvalId: id, approved })
  }

  /** Sends an event to the renderer. A failing sink never interrupts the session. */
  private notify(event: ChatEvent): void {
    try {
      this.deps.emit(event)
    } catch {
      // The window may be gone; the session's own state is what matters.
    }
  }

  /** Denies every pending approval (of one run, or all). */
  denyPending(runId?: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (runId === undefined || entry.runId === runId) this.settle(id, entry, false)
    }
  }

  /**
   * Cancels the run in flight (if any) and denies every pending approval, then
   * waits for the run to wind down. Aborting comes first so a failing
   * notification can never leave the run going.
   */
  async stop(): Promise<void> {
    const active = this.active
    active?.controller.abort()
    this.denyPending()
    if (active) await active.done
  }

  /**
   * Starts a new chat on the current connection (its home once saved); the open one
   * stays in the history. Nothing is saved until the first send.
   */
  newChat(): Promise<ChatState> {
    return this.switchTo(async () => {
      const home = this.library.connection()
      const history = await this.library.historyFor(home)
      return {
        home,
        history,
        store: history.draft(),
        id: null,
        commit: () => this.commitDraft(history),
      }
    })
  }

  private async commitDraft(history: ConversationHistory): Promise<void> {
    await history.setActive(null)
    await this.library.remember(null)
  }

  /**
   * Opens a saved chat of any home connection and continues it on the current one.
   * A reply still running is stopped first: it is saved to the conversation it
   * belongs to, and its approvals are denied.
   */
  openChat(chat: ChatRef): Promise<ChatState> {
    return this.switchTo(async () => {
      const history = await this.library.historyFor(chat.provider)
      if (!history.has(chat.id)) throw new Error('That chat no longer exists.')
      return {
        home: chat.provider,
        history,
        store: history.open(chat.id),
        id: chat.id,
        commit: async () => {
          // The home's own activeId too, for older builds that read only that.
          await history.setActive(chat.id)
          await this.library.remember({ provider: chat.provider, id: chat.id })
        },
      }
    })
  }

  /** Opens a saved chat of the current connection's own history (older renderers). */
  open(id: unknown): Promise<ChatState> {
    if (typeof id !== 'string') return Promise.reject(new Error('That chat no longer exists.'))
    return this.openChat({ provider: this.library.connection(), id })
  }

  /**
   * Changes the connection replies go to, through `switchTo`: the run is stopped
   * and its approvals denied at once, the switch waits for it to end, then
   * `commit` makes `next` current. A saved chat that is open is reopened and
   * continues on `next`; a new chat becomes a new chat of `next`.
   */
  switchConnection(next: ConnectionId, commit: () => Promise<void>): Promise<ChatState> {
    return this.switchTo(async () => {
      // Opened before the commit, so the list never lacks the current connection's chats.
      const nextHistory = await this.library.historyFor(next)
      // Read after the run ended: a first send may have just saved a new chat.
      const id = this.store.id?.() ?? this.openId
      if (id !== null && this.history.has(id)) {
        return { home: this.home, history: this.history, store: this.history.open(id), id, commit }
      }
      return {
        home: next,
        history: nextHistory,
        store: nextHistory.draft(),
        id: null,
        commit: async () => {
          await commit()
          await this.commitDraft(nextHistory)
        },
      }
    })
  }

  /** The chat list changed outside the session (a pin, archive, move or fork). */
  historyChanged(): void {
    this.notifyHistory()
  }

  async renameChat(chat: ChatRef, title: string): Promise<HistoryState> {
    const history = await this.library.historyFor(chat.provider)
    await history.rename(chat.id, title)
    this.notifyHistory()
    return this.historyState()
  }

  /** Renames a chat of the current connection's own history (older renderers). */
  rename(id: string, title: string): Promise<HistoryState> {
    return this.renameChat({ provider: this.library.connection(), id }, title)
  }

  private isOpen(chat: ChatRef): boolean {
    const active = this.openRef
    return active !== null && active.provider === chat.provider && active.id === chat.id
  }

  /** Deletes a saved chat of any home. Deleting the open one first starts a new chat. */
  async removeChat(chat: ChatRef): Promise<HistoryState> {
    const history = await this.library.historyFor(chat.provider)
    if (!history.has(chat.id)) return this.historyState()
    if (this.isOpen(chat)) await this.newChat()
    // Reopened while the new chat started: leave it be.
    if (this.isOpen(chat)) return this.historyState()
    try {
      await history.remove(chat.id)
    } catch (error) {
      this.deps.onSaveError?.(error)
      this.notify({
        type: 'storage_warning',
        message: 'The chat could not be deleted from disk. It may come back after a restart.',
      })
    }
    this.notifyHistory()
    return this.historyState()
  }

  /** Deletes a chat of the current connection's own history (older renderers). */
  remove(id: string): Promise<HistoryState> {
    return this.removeChat({ provider: this.library.connection(), id })
  }

  /**
   * Reserves the send slot, stops the run and denies its approvals
   * synchronously, then, in turn with other switches, waits for the run to
   * end and opens `prepare()`'s conversation. The generation bump means a
   * runner or save of the run before can never touch the next one. A load or
   * commit failure leaves the current conversation open.
   */
  private switchTo(prepare: () => SwitchTarget | Promise<SwitchTarget>): Promise<ChatState> {
    this.resets += 1
    this.active?.controller.abort()
    this.denyPending()
    const switched = this.resetQueue.then(async () => {
      try {
        await this.stop()
        const next = await prepare()
        const loaded = await next.store.load()
        const unavailable = await unavailableAttachments(loaded.messages, this.deps.attachments)
        await next.commit()
        this.generation += 1
        this.home = next.home
        this.history = next.history
        this.store = next.store
        this.openId = next.id
        this.conversation = loaded.messages
        this.origin = loaded.origin ?? []
        this.unavailable = unavailable
        this.loadError = loaded.error
        this.notify({ type: 'conversation_reset', state: this.state() })
        return this.state()
      } finally {
        this.resets -= 1
      }
    })
    this.resetQueue = switched.catch(() => {})
    return switched
  }

  /** Waits for the run in flight, if any. */
  async idle(): Promise<void> {
    await this.active?.done
  }

  private notifyHistory(): void {
    this.notify({ type: 'history_changed', history: this.historyState() })
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(this.conversation, this.origin)
      // A new chat's first save gives it an id: it is the open chat from now on.
      const id = this.store.id?.() ?? this.openId
      if (id !== this.openId) {
        this.openId = id
        if (id !== null) await this.library.remember({ provider: this.home, id })
      }
    } catch (error) {
      this.deps.onSaveError?.(error)
      this.notify({
        type: 'storage_warning',
        message:
          'The conversation could not be saved to disk. It will be lost when the app closes.',
      })
    }
    // A first save adds the chat to the list; any save moves it to the top.
    this.notifyHistory()
  }
}

/**
 * A prompt as it is saved: plain text as before (a command-bar header typed in
 * the composer never makes a card, see user-command.ts), or, with attachments,
 * the text (if any) and then one block per attachment.
 */
function promptMessage(text: string, attachments: readonly AttachmentRef[]): StoredMessage {
  if (attachments.length === 0) return { role: 'user', content: text }
  const blocks: AttachmentBlock[] = attachments.map((ref) => ({ type: 'attachment', ...ref }))
  return {
    role: 'user',
    content: [...(text.trim() ? [{ type: 'text' as const, text }] : []), ...blocks],
  }
}
