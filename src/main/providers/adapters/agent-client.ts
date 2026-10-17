import { createAgent, type AgentClient } from '../../agent'
import type { AdapterFactory, AdapterHost, ConnectionDescriptor } from '../connection'
import { mapFailure, SetupError, type FailureWording } from '../errors'

/** A connection that talks to a model API directly, through the app's own agent loop. */
export interface AgentClientSpec extends ConnectionDescriptor {
  /**
   * The client for one Send. `key` is the connection's saved API key when its
   * authKind is 'api-key' (the runner refuses to start without one), otherwise null.
   */
  client: (credentials: { key: string | null }) => AgentClient
  /** The model id to send, read at each Send. */
  model: (host: AdapterHost) => string
  /** The status line Settings shows; these connections have nothing to sign in to. */
  readyMessage: string
  /** Shown when Send finds no saved key. */
  missingKeyMessage: string
  wording: FailureWording
}

/**
 * The slot for API connections: describe the connection, supply an AgentClient
 * (src/main/agent/types.ts), and createAgent runs the same tool loop, approvals
 * and audit as every other connection. Register the result with
 * ConnectionService.registerAdapter; see docs/connections.md.
 */
export function agentClientAdapter(spec: AgentClientSpec): AdapterFactory {
  const { client, model, readyMessage, missingKeyMessage, wording, ...descriptor } = spec
  return (host) => ({
    ...descriptor,
    failure: (error) =>
      error instanceof SetupError
        ? { code: error.code, message: error.message }
        : mapFailure(error, wording),
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
      return createAgent({ client: client({ key }), tools, model: model(host) })
    },
  })
}
