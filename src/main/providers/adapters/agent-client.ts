import { createAgent, type AgentClient, type AgentEvent } from '../../agent'
import type { AdapterFactory, AdapterHost, ConnectionDescriptor } from '../connection'
import { SetupError, SubscriptionError } from '../errors'

/** A connection that talks to a model API directly, through the app's own agent loop. */
export interface AgentClientSpec extends ConnectionDescriptor {
  /**
   * The client for one Send. `key` is the connection's saved API key when its
   * authKind is 'api-key' (the runner refuses to start without one), otherwise null.
   * `model` is model(host), for clients that take it when they are built.
   */
  client: (options: { key: string | null; model: string }) => AgentClient
  /** The model id to send, read at each Send (a connection may have to list its models first). */
  model: (host: AdapterHost) => string | Promise<string>
  /** Who the agent loop's own messages name; default shortLabel ("Claude" for Anthropic). */
  modelName?: string
  /** The status line Settings shows; these connections have nothing to sign in to. */
  readyMessage: string
  /** Shown when Send finds no saved key. */
  missingKeyMessage: string
  /**
   * The client's own error mapper (apiErrorEvent, openAICompatErrorEvent,
   * geminiErrorEvent): a safe code and app-written message for whatever the
   * client throws, used by the agent loop and by failure().
   */
  errorEvent: (error: unknown) => Extract<AgentEvent, { type: 'error' }>
}

/**
 * The slot for API connections: describe the connection, supply an AgentClient
 * (src/main/agent/types.ts), and createAgent runs the same tool loop, approvals
 * and audit as every other connection. Register the result with
 * ConnectionService.registerAdapter; see docs/connections.md.
 */
export function agentClientAdapter(spec: AgentClientSpec): AdapterFactory {
  const { client, model, modelName, readyMessage, missingKeyMessage, errorEvent, ...descriptor } =
    spec
  return (host) => ({
    ...descriptor,
    failure: (error) => {
      // Setup and service errors already carry a message written here.
      if (error instanceof SetupError) return { code: error.code, message: error.message }
      if (error instanceof SubscriptionError) return error
      const { code, message, resetsAt } = errorEvent(error)
      return { code, message, ...(resetsAt ? { resetsAt } : {}) }
    },
    status: () => Promise.resolve({ provider: spec.id, state: 'ready', message: readyMessage }),
    async runner(tools) {
      let key: string | null = null
      if (spec.capabilities.authKind === 'api-key') {
        try {
          key = (await host.keys?.forConnection(spec.id).get()) ?? null
        } catch (error) {
          // The key store's messages are written for users and never contain the key.
          throw new SetupError(
            'key_unreadable',
            error instanceof Error ? error.message : 'The saved API key cannot be read.',
          )
        }
        if (!key) throw new SetupError('no_api_key', missingKeyMessage)
      }
      const chosen = await model(host)
      return createAgent({
        client: client({ key, model: chosen }),
        tools,
        model: chosen,
        errorEvent,
        modelName: modelName ?? spec.shortLabel,
      })
    },
  })
}
