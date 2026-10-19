import { randomUUID } from 'node:crypto'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type {
  ApprovalOrigin,
  ApprovalPrompt,
  ChatErrorCode,
  ChatEvent,
  ChatState,
  HistoryState,
  SendResult,
} from '../../shared/ipc'
import type {
  AgentEvent,
  AgentTool,
  ApprovalRequest,
  RunOptions,
  RunResult,
  ToolResult,
} from '../agent'
import type { ConversationStore } from '../storage/conversation-store'
import type { ConversationHistory } from '../storage/history-store'
import { toTranscript } from './transcript'
import { userCommandMessage } from './user-command'

/** What a switch opens: a conversation, and what to record once it has loaded. */
interface SwitchTarget {
  store: ConversationStore
  commit: () => Promise<void>
  /** Set by a provider switch: the new provider's history. */
  history?: ConversationHistory
}

/** One agent run. `createAgent(...)` satisfies this. */
export interface AgentRunner {
  run: (conversation: MessageParam[], options: RunOptions) => Promise<RunResult>
}

export type RunnerResult =
  | { ok: true; runner: AgentRunner }
  | { ok: false; code: ChatErrorCode; message: string; resetsAt?: string }

export interface ChatSessionDeps {
  /** The current provider's saved conversations; the open one is loaded by `init`. */
  history: ConversationHistory
  /** Builds an agent with the current API key, model and tools. */
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
 * Opening another conversation, New chat and provider switches all go
 * through `switchTo`: the send slot is reserved and the run stopped (its
 * approvals denied) synchronously, then the switch waits for the run to end
 * (it saves to the conversation it belongs to) before loading the next one.
 */
export class ChatSession {
  private conversation: MessageParam[] = []
  private history: ConversationHistory
  private store: ConversationStore
  private loadError: string | null = null
  private active: ActiveRun | null = null
  private readonly pending = new Map<string, PendingApproval>()
  private readonly newId: () => string
  /** Bumped by every switch; a run or save from an older generation never touches history. */
  private generation = 0
  /** Loads and switches in flight. While > 0, send() is refused. */
  private resets = 0
  private resetQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ChatSessionDeps) {
    this.newId = deps.newId ?? randomUUID
    this.history = deps.history
    this.store = deps.history.current()
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
        const { messages, error } = await this.store.load()
        this.conversation = messages
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
      items: toTranscript(this.conversation),
      running: this.running,
      loadError: this.loadError,
      history: this.history.state(),
    }
  }

  /** The current provider's saved conversations. */
  historyState(): HistoryState {
    return this.history.state()
  }

  /** Starts a run. Resolves once it has started, not when it finishes (see `idle`). */
  async send(text: unknown): Promise<SendResult> {
    if (typeof text !== 'string' || !text.trim())
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

    let built: RunnerResult
    try {
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

    this.conversation = [...this.conversation, { role: 'user', content: text }]
    this.loadError = null
    await this.persist()
    if (cancelled()) {
      this.active = null
      release()
      return { ok: false, code: 'aborted', message: 'Stopped before the reply started.' }
    }
    this.notify({ type: 'run_started', runId: id, text })
    void this.execute(built.runner, id, controller, generation).finally(() => {
      this.denyPending(id)
      this.active = null
      release()
    })
    return { ok: true }
  }

  private async execute(
    runner: AgentRunner,
    runId: string,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    // The agent emits approval_requested synchronously right before calling
    // requestApproval, which lets the prompt name its tool call.
    let approvalToolUseId: string | null = null
    let result: RunResult
    try {
      result = await runner.run(this.conversation, {
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
      this.conversation = result.conversation
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

  /** Starts a new chat; the open one stays in the history. Nothing is saved until the first send. */
  newChat(): Promise<ChatState> {
    return this.switchTo(() => {
      const history = this.history
      return { store: history.draft(), commit: () => history.setActive(null) }
    })
  }

  /**
   * Opens a saved conversation of the current provider. A reply still running
   * is stopped first, as for a provider switch: it is saved to the
   * conversation it belongs to, and its approvals are denied.
   */
  open(id: unknown): Promise<ChatState> {
    return this.switchTo(() => {
      const history = this.history
      if (typeof id !== 'string' || !history.has(id)) throw new Error('That chat no longer exists.')
      return { store: history.open(id), commit: () => history.setActive(id) }
    })
  }

  /**
   * Switches to another provider's history and opens its last conversation, or
   * the saved conversation `id` of that history.
   */
  switchHistory(
    history: ConversationHistory,
    commit: () => Promise<void>,
    id?: string,
  ): Promise<ChatState> {
    return this.switchTo(() => {
      if (id === undefined) return { store: history.current(), commit, history }
      if (!history.has(id)) throw new Error('That chat no longer exists.')
      return {
        store: history.open(id),
        commit: async () => {
          await commit()
          await history.setActive(id)
        },
        history,
      }
    })
  }

  /** The open provider's chat list changed outside the session (a pin, archive or move). */
  historyChanged(): void {
    this.notifyHistory()
  }

  async rename(id: string, title: string): Promise<HistoryState> {
    await this.history.rename(id, title)
    this.notifyHistory()
    return this.history.state()
  }

  /** Deletes a saved conversation. Deleting the open one first starts a new chat. */
  async remove(id: string): Promise<HistoryState> {
    const history = this.history
    if (!history.has(id)) return this.history.state()
    if (history.activeId === id) await this.newChat()
    // Reopened (or the provider changed) while the new chat started: leave it be.
    if (this.history !== history || history.activeId === id) return this.history.state()
    try {
      await history.remove(id)
    } catch (error) {
      this.deps.onSaveError?.(error)
      this.notify({
        type: 'storage_warning',
        message: 'The chat could not be deleted from disk. It may come back after a restart.',
      })
    }
    this.notifyHistory()
    return this.history.state()
  }

  /**
   * Reserves the send slot, stops the run and denies its approvals
   * synchronously, then, in turn with other switches, waits for the run to
   * end and opens `prepare()`'s conversation. A load or commit failure leaves
   * the current conversation open.
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
        await next.commit()
        this.generation += 1
        if (next.history) this.history = next.history
        this.store = next.store
        this.conversation = loaded.messages
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
    this.notify({ type: 'history_changed', history: this.history.state() })
  }

  private async persist(): Promise<void> {
    try {
      await this.store.save(this.conversation)
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
