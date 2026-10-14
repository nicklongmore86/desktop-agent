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
    if (this.active)
      return { ok: false, code: 'busy', message: 'Wait for the current reply, or stop it.' }

    // Claim the slot before awaiting, so two quick sends cannot both start.
    const id = this.newId()
    const controller = new AbortController()
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
    if (!built.ok || controller.signal.aborted) {
      this.active = null
      release()
      return built.ok
        ? { ok: false, code: 'aborted', message: 'Stopped before the reply started.' }
        : { ok: false, code: built.code, message: built.message }
    }

    this.conversation = [...this.conversation, { role: 'user', content: text }]
    this.loadError = null
    await this.persist()
    this.deps.emit({ type: 'run_started', runId: id, text })
    void this.execute(built.runner, id, controller).finally(() => {
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
      this.deps.emit({
        type: 'error',
        runId,
        code: 'internal',
        message: 'The agent stopped unexpectedly.',
      })
      this.deps.emit({ type: 'run_finished', runId, stopReason: 'internal' })
      return
    }
    this.conversation = result.conversation
    await this.persist()
    this.deps.emit({ type: 'run_finished', runId, stopReason: result.stopReason })
  }

  private forward(runId: string, event: AgentEvent): void {
    switch (event.type) {
      case 'text_delta':
        this.deps.emit({ type: 'text_delta', runId, turn: event.turn, text: event.text })
        break
      case 'response_discarded':
        this.deps.emit({ type: 'response_discarded', runId, turn: event.turn })
        break
      case 'tool_use':
        this.deps.emit({
          type: 'tool_use',
          runId,
          turn: event.turn,
          id: event.id,
          name: event.name,
          input: event.input,
        })
        break
      case 'tool_result':
        this.deps.emit({
          type: 'tool_result',
          runId,
          id: event.id,
          content: event.result.content,
          isError: event.result.isError === true,
        })
        break
      case 'error':
        this.deps.emit({
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
      this.deps.promptApproval({
        id,
        runId,
        toolUseId,
        tool: request.tool,
        kind: request.kind,
        summary: request.summary,
        detail: request.detail ?? null,
      })
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
    this.deps.emit({ type: 'approval_closed', approvalId: id, approved })
  }

  /** Denies every pending approval (of one run, or all). */
  denyPending(runId?: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (runId === undefined || entry.runId === runId) this.settle(id, entry, false)
    }
  }

  /** Cancels the run in flight (if any), denying its approvals, and waits for it to wind down. */
  async stop(): Promise<void> {
    this.denyPending()
    const active = this.active
    if (!active) return
    active.controller.abort()
    await active.done
  }

  /** Stops any run and starts an empty conversation. */
  async newChat(): Promise<ChatState> {
    await this.stop()
    this.conversation = []
    this.loadError = null
    try {
      await this.deps.store.clear()
    } catch (error) {
      this.deps.onSaveError?.(error)
    }
    this.deps.emit({ type: 'conversation_reset' })
    return this.state()
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
    }
  }
}
