import { randomUUID } from 'node:crypto'
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages'
import type {
  ApprovalPrompt,
  ChatErrorCode,
  ChatEvent,
  ChatState,
  SendResult,
} from '../../shared/ipc'
import type { AgentEvent, ApprovalRequest, RunOptions, RunResult } from '../agent'
import type { ConversationStore } from '../storage/conversation-store'
import { toTranscript } from './transcript'

/** One agent run. `createAgent(...)` satisfies this. */
export interface AgentRunner {
  run: (conversation: MessageParam[], options: RunOptions) => Promise<RunResult>
}

export type RunnerResult =
  { ok: true; runner: AgentRunner } | { ok: false; code: ChatErrorCode; message: string }

export interface ChatSessionDeps {
  store: ConversationStore
  /** Builds an agent with the current API key, model and tools. */
  createRunner: () => Promise<RunnerResult>
  /** Streams an event to the renderer. */
  emit: (event: ChatEvent) => void
  /** Shows an approval prompt in the renderer. */
  promptApproval: (prompt: ApprovalPrompt) => void
  newId?: () => string
  /** Persistence failures; the conversation stays in memory. */
  onSaveError?: (error: unknown) => void
}

interface PendingApproval {
  runId: string
  resolve: (approved: boolean) => void
}

interface ActiveRun {
  id: string
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
 */
export class ChatSession {
  private conversation: MessageParam[] = []
  private loadError: string | null = null
  private active: ActiveRun | null = null
  private readonly pending = new Map<string, PendingApproval>()
  private readonly newId: () => string
  /** Bumped by every New chat; a run or save from an older generation never touches history. */
  private generation = 0
  /** New chat calls in flight. While > 0, send() is refused. */
  private resets = 0
  private resetQueue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ChatSessionDeps) {
    this.newId = deps.newId ?? randomUUID
  }

  async init(): Promise<void> {
    const { messages, error } = await this.deps.store.load()
    this.conversation = messages
    this.loadError = error
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
    }
  }

  /** Starts a run. Resolves once it has started, not when it finishes (see `idle`). */
  async send(text: unknown): Promise<SendResult> {
    if (typeof text !== 'string' || !text.trim())
      return { ok: false, code: 'invalid_request', message: 'Type a message first.' }
    if (this.resets > 0)
      return { ok: false, code: 'busy', message: 'A new chat is being started. Try again.' }
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
      controller,
      done: new Promise((resolve) => {
        release = resolve
      }),
    }

    let built: RunnerResult
    try {
      built = await this.deps.createRunner()
    } catch {
      built = { ok: false, code: 'internal', message: 'Could not start the agent.' }
    }
    if (!built.ok || cancelled()) {
      this.active = null
      release()
      return built.ok
        ? { ok: false, code: 'aborted', message: 'Stopped before the reply started.' }
        : { ok: false, code: built.code, message: built.message }
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
        })
        break
      case 'error':
        this.notify({
          type: 'error',
          runId,
          code: toChatCode(event.code),
          message: event.message,
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
        })
      } catch {
        // The prompt never reached the user, so it can only be a denial.
        const entry = this.pending.get(id)
        if (entry) this.settle(id, entry, false)
      }
    })
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
   * Stops any run and starts an empty conversation. The reset is reserved
   * synchronously, so a send() racing it is refused; repeated calls run one
   * after another; conversation_reset is sent only once the saved history
   * is gone (or a warning says it could not be deleted).
   */
  newChat(): Promise<ChatState> {
    this.resets += 1
    this.generation += 1
    this.active?.controller.abort()
    this.denyPending()
    const reset = this.resetQueue.then(async () => {
      try {
        await this.stop()
        this.conversation = []
        this.loadError = null
        try {
          await this.deps.store.clear()
        } catch (error) {
          this.deps.onSaveError?.(error)
          this.notify({
            type: 'storage_warning',
            message:
              'The previous conversation could not be deleted from disk. It may come back after a restart.',
          })
        }
        this.notify({ type: 'conversation_reset' })
        return this.state()
      } finally {
        this.resets -= 1
      }
    })
    this.resetQueue = reset.catch(() => {})
    return reset
  }

  /** Waits for the run in flight, if any. */
  async idle(): Promise<void> {
    await this.active?.done
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.store.save(this.conversation)
    } catch (error) {
      this.deps.onSaveError?.(error)
      this.notify({
        type: 'storage_warning',
        message:
          'The conversation could not be saved to disk. It will be lost when the app closes.',
      })
    }
  }
}
