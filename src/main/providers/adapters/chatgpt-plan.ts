import type { ProviderFailure, ProviderModels, ProviderStatus } from '../../../shared/ipc'
import { CHATGPT_PLAN } from '../../../shared/ipc-connections'
import { createAgent, type AgentClient, type AgentErrorCode, type AgentEvent } from '../../agent'
import { OpenAICompatError, openAICompatErrorEvent } from '../../llm/openai-compat/errors'
import type { FetchLike } from '../../llm/openai-compat/http'
import {
  createChatGPTResponsesClient,
  isToolFormatError,
  listChatGPTModels,
  ResponsesError,
  type ChatGPTModel,
} from '../../llm/openai-responses'
import {
  ChatgptAuthError,
  createChatgptAuth,
  type ChatgptAuth,
  type ChatgptAuthStatus,
} from '../chatgpt-auth'
import type { AdapterFactory, AdapterHost, ConnectionAdapter } from '../connection'
import { SetupError, SubscriptionError } from '../errors'

export interface ChatgptPlanOptions {
  /** Tests: the sign-in service (against the fake OpenAI auth server). */
  auth?: (host: AdapterHost) => ChatgptAuth
  /** Tests: serves api.openai.com from a local fake Responses server. */
  fetch?: FetchLike
  /** Receives fixed, redacted lines only (sign-in events, tool-format rejections). */
  log?: (line: string) => void
}

const CACHE_MS = 60_000
const SIGNED_OUT_MESSAGE = 'Sign in with ChatGPT to use your plan.'
const SIGN_IN_AGAIN = 'Your ChatGPT sign-in has ended. Sign in with ChatGPT again.'
const READY_MESSAGE = 'Signed in with ChatGPT. Uses your plan’s limits; no API key is used.'
const NOT_ENTITLED =
  'Needs ChatGPT Plus or Pro. On other plans, use Codex · ChatGPT or an OpenAI API key instead.'

/** Sign-in service errors as a safe code; every ChatgptAuthError message is fixed text. */
function authFailure(error: ChatgptAuthError): { code: AgentErrorCode; message: string } {
  switch (error.code) {
    case 'signed-out':
      return { code: 'authentication', message: SIGNED_OUT_MESSAGE }
    case 'sign-in-again':
    case 'plan-not-enabled':
      return { code: 'auth_expired', message: SIGN_IN_AGAIN }
    case 'network':
      return { code: 'network', message: error.message }
    case 'server':
      return { code: 'overloaded', message: error.message }
    default:
      return { code: 'authentication', message: error.message }
  }
}

/** What the renderer is told about the sign-in: never a token, code or client id. */
function signInStatus(auth: ChatgptAuthStatus): ProviderStatus {
  const provider = CHATGPT_PLAN
  switch (auth.state) {
    case 'signed-in':
      return { provider, state: 'ready', signedIn: true, message: READY_MESSAGE }
    case 'signing-in':
      return { provider, state: 'signed-out', signedIn: false, message: 'Signing in…' }
    case 'signed-out':
      return { provider, state: 'signed-out', signedIn: false, message: SIGNED_OUT_MESSAGE }
    case 'sign-in-again': {
      const failure: ProviderFailure =
        auth.reason === 'unreadable'
          ? {
              code: 'key_unreadable',
              message: 'The saved ChatGPT sign-in can’t be read. Sign in with ChatGPT again.',
            }
          : auth.reason === 'plan-not-enabled'
            ? {
                code: 'auth_expired',
                message:
                  'ChatGPT plan use isn’t allowed for Desktop Agent. Sign in again and allow it.',
              }
            : { code: 'auth_expired', message: SIGN_IN_AGAIN }
      return { provider, state: 'signed-out', signedIn: false, message: failure.message, failure }
    }
  }
}

/**
 * ChatGPT plan use (Plus and Pro): Sign in with ChatGPT (chatgpt-auth, main only) and the
 * Responses API client (llm/openai-responses) under the app's own agent loop, so tools,
 * approvals and the audit log are the same as every other connection. The access token is
 * read in main before each request and only ever sent as the Authorization header; the
 * renderer learns the sign-in state and nothing else. The API reports no usage, so there
 * is no allowance: a limit shows as an error after the fact. Distinct from Codex ·
 * ChatGPT, which stays for ChatGPT Free and the other plans.
 */
export const chatgptPlanAdapter =
  (options: ChatgptPlanOptions = {}): AdapterFactory =>
  (host) => {
    const id = CHATGPT_PLAN
    const log = (line: string): void => {
      try {
        ;(options.log ?? console.info)(line)
      } catch {
        // Logging never fails an operation.
      }
    }
    let service: ChatgptAuth | undefined
    const auth = (): ChatgptAuth => {
      if (service) return service
      if (options.auth) return (service = options.auth(host))
      const { keys, settings } = host
      if (!keys || !settings)
        throw new SetupError('key_unreadable', 'ChatGPT sign-in is unavailable.')
      return (service = createChatgptAuth({ keys, settings, log }))
    }

    /** A run's sign-in failure: the API refused the token, so status says to sign in again. */
    let rejected: ProviderFailure | undefined
    /** The last run said the plan cannot use this (Plus or Pro needed). */
    let notEntitled: ProviderFailure | undefined
    let cache: { models: ChatGPTModel[]; at: number } | undefined

    const getAccessToken = async (): Promise<string> => {
      try {
        return await auth().getAccessToken()
      } catch (error) {
        if (error instanceof ChatgptAuthError) {
          const { code, message } = authFailure(error)
          throw new OpenAICompatError(code, message)
        }
        if (error instanceof SetupError)
          throw new OpenAICompatError('authentication', error.message)
        throw new OpenAICompatError('auth_expired', SIGN_IN_AGAIN)
      }
    }

    /** The client's own mapping, with this connection's wording and its run state. */
    const errorEvent = (error: unknown): Extract<AgentEvent, { type: 'error' }> => {
      const event = openAICompatErrorEvent(error)
      if (isToolFormatError(error))
        // Both parts passed the client's own patterns: a field path and a request id.
        log(
          `chatgpt-plan: tool format rejected (param=${error.param}${error.requestId ? `, request=${error.requestId}` : ''})`,
        )
      if (event.code === 'auth_expired') rejected = { code: event.code, message: event.message }
      if (event.code === 'plan_not_entitled') {
        notEntitled = { code: 'plan_not_entitled', message: NOT_ENTITLED }
        // The run's own error keeps the client's diagnostics (status, code, request id).
        const details = error instanceof ResponsesError ? error.details : ''
        return { ...event, message: `${NOT_ENTITLED}${details}` }
      }
      return event
    }

    /** Clears the run state once a reply arrives. */
    const observed = (client: AgentClient): AgentClient => ({
      messages: {
        stream: (params, context) => {
          const stream = client.messages.stream(params, context)
          stream.finalMessage().then(
            () => {
              rejected = undefined
              notEntitled = undefined
            },
            () => {},
          )
          return stream
        },
      },
    })

    const listModels = async (): Promise<ChatGPTModel[]> => {
      if (cache && Date.now() - cache.at < CACHE_MS) return cache.models
      const models = await listChatGPTModels({
        getAccessToken,
        ...(options.fetch ? { fetch: options.fetch } : {}),
        signal: AbortSignal.timeout(15_000),
      })
      cache = { models, at: Date.now() }
      return models
    }

    const models = async (): Promise<ProviderModels> => {
      const listed = await listModels()
      const savedModel = host.settings?.selection(id) ?? null
      // The server lists models in OpenAI's order; the first is the default.
      const defaultModel = listed[0]?.slug ?? null
      const selectedModel =
        savedModel && listed.some((model) => model.slug === savedModel) ? savedModel : defaultModel
      return {
        provider: id,
        options: listed.map((model) => ({
          id: model.slug,
          label: model.displayName,
          defaultReasoningEffort: null,
          supportedReasoningEfforts: [],
          isDefault: model.slug === defaultModel,
        })),
        selectedModel,
        savedModel,
        defaultModel,
        resolvedModel: selectedModel,
      }
    }

    const failure = (error: unknown): ProviderFailure => {
      if (error instanceof SetupError) return { code: error.code, message: error.message }
      if (error instanceof SubscriptionError) return error
      if (error instanceof ChatgptAuthError) return authFailure(error)
      const { code, message, resetsAt } = errorEvent(error)
      return { code, message, ...(resetsAt ? { resetsAt } : {}) }
    }

    const adapter: ConnectionAdapter = {
      id,
      vendor: 'openai',
      access: 'plan',
      label: 'ChatGPT · Plan',
      shortLabel: 'ChatGPT',
      title: 'ChatGPT · Plan',
      description: 'Sign in with ChatGPT to use your Plus or Pro plan. No API key needed.',
      capabilities: {
        authKind: 'chatgpt-login',
        listsModels: true,
        reportsUsage: false,
        needsRuntime: false,
      },
      personalUseOnly: false,
      pickerOrder: 8,
      failure,
      models,

      invalidate() {
        cache = undefined
      },

      async setModel(model) {
        const catalog = await models()
        if (model !== null && !catalog.options.some((option) => option.id === model))
          throw new SetupError('model_unavailable', 'Choose an available ChatGPT model.')
        await host.settings?.setSelection(id, model)
        const selectedModel = model ?? catalog.defaultModel
        return { ...catalog, savedModel: model, selectedModel, resolvedModel: selectedModel }
      },

      /** Read from the saved sign-in only: no request to OpenAI, so it is quick and free. */
      async status() {
        try {
          const status = signInStatus(await auth().status())
          if (status.state !== 'ready') return status
          if (rejected)
            return {
              provider: id,
              state: 'signed-out',
              signedIn: false,
              message: SIGN_IN_AGAIN,
              failure: { code: 'auth_expired', message: SIGN_IN_AGAIN },
            }
          if (notEntitled)
            return {
              provider: id,
              state: 'not-entitled',
              signedIn: true,
              availability: 'blocked',
              message: notEntitled.message,
              failure: notEntitled,
            }
          return status
        } catch (error) {
          const mapped = failure(error)
          return { provider: id, state: 'error', message: mapped.message, failure: mapped }
        }
      },

      async login(session) {
        const service = auth()
        const before = await service.status()
        await service.login({
          signal: session.signal,
          openUrl: host.openUrl,
          // Plan use was declined last time: show the consent screen again.
          ...(before.state === 'sign-in-again' && before.reason === 'plan-not-enabled'
            ? { reconsent: true }
            : {}),
        })
        rejected = undefined
        notEntitled = undefined
        cache = undefined
      },

      async forget() {
        const result = await auth().signOut()
        rejected = undefined
        notEntitled = undefined
        cache = undefined
        return result.confirmed ? null : (result.message ?? null)
      },

      async runner(tools) {
        const chosen = host.settings?.selection(id) ?? (await models()).defaultModel
        if (!chosen)
          throw new SetupError(
            'model_unavailable',
            'No ChatGPT models are available for this plan.',
          )
        const client = createChatGPTResponsesClient({
          model: chosen,
          getAccessToken,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        })
        return createAgent({
          client: observed(client),
          tools,
          model: chosen,
          errorEvent,
          modelName: 'ChatGPT',
        })
      },
    }
    return adapter
  }

export const createChatgptPlanAdapter = chatgptPlanAdapter()
