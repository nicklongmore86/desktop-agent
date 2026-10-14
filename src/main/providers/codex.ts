import type { AgentTool, RunResult } from '../agent'
import { DEFAULT_SYSTEM_PROMPT } from '../agent'
import type { AgentRunner } from '../chat/session'
import features from './codex-features.json'
import { ToolBridge, transcriptPrompt } from './bridge'
import { RpcPeer, object, type RpcObject } from './rpc'
import { launch } from './runtime'

export interface RuntimeContext {
  file: string
  cwd: string
  env: NodeJS.ProcessEnv
}

/** Pinned 0.162.1: no environment means no filesystem/apply_patch/exec handlers. */
export const CODEX_CONFIG = {
  features,
  forced_login_method: 'chatgpt',
  cli_auth_credentials_store: 'file',
  mcp_servers: {},
  plugins: {},
  web_search: 'disabled',
  tools: { update_plan: { enabled: false }, experimental_request_user_input: { enabled: false } },
  project_doc_max_bytes: 0,
  include_apps_instructions: false,
  include_collaboration_mode_instructions: false,
}

export async function connectCodex(
  context: RuntimeContext,
  signal?: AbortSignal,
): Promise<RpcPeer> {
  signal?.throwIfAborted()
  // Object config values are TOML inline tables, not JSON objects.
  const toml = (value: unknown): string => {
    if (value && typeof value === 'object' && !Array.isArray(value))
      return (
        '{' +
        Object.entries(value)
          .map(([k, v]) => `${k}=${toml(v)}`)
          .join(',') +
        '}'
      )
    return JSON.stringify(value)
  }
  const args = [
    'app-server',
    '--listen',
    'stdio://',
    '--strict-config',
    ...Object.entries(CODEX_CONFIG).flatMap(([key, value]) => ['-c', `${key}=${toml(value)}`]),
  ]
  const peer = new RpcPeer(launch(context.file, args, context.cwd, context.env), 15000, signal)
  try {
    await peer.request('initialize', {
      clientInfo: { name: 'desktop_file_agent', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    })
    peer.notify('initialized')
    const config = await peer.request('config/read', { includeLayers: true })
    const layers = config['layers']
    if (
      !Array.isArray(layers) ||
      layers.some(
        (layer) =>
          object(object(layer)['name'])['type'] !== 'sessionFlags' &&
          Object.keys(object(object(layer)['config'])).length > 0,
      )
    )
      throw new Error(
        'Unsupported inherited Codex configuration: ' +
          JSON.stringify(Array.isArray(layers) ? layers.map((layer) => object(layer)['name']) : []),
      )
    const requirements = await peer.request('configRequirements/read')
    if (
      requirements['requirements'] != null &&
      Object.entries(object(requirements['requirements'])).some(
        ([key, value]) =>
          value !== null &&
          !(key === 'allowedLoginMethods' && JSON.stringify(value) === '["chatgpt"]'),
      )
    )
      throw new Error('Unsupported managed Codex requirements. This integration fails closed.')
    return peer
  } catch (error) {
    peer.close()
    throw error
  }
}

export async function codexAccount(peer: RpcPeer): Promise<boolean> {
  const result = await peer.request('account/read', { refreshToken: true })
  return result['account'] !== null && object(result['account'])['type'] === 'chatgpt'
}

export function createCodexRunner(context: RuntimeContext, tools: AgentTool[]): AgentRunner {
  return {
    async run(conversation, options): Promise<RunResult> {
      const runController = new AbortController()
      const bridge = new ToolBridge(conversation, tools, {
        ...options,
        signal: AbortSignal.any([options.signal, runController.signal]),
      })
      let peer: RpcPeer | undefined
      let timer: NodeJS.Timeout | undefined
      const abort = () => peer?.close(new Error('Cancelled.'))
      options.signal.addEventListener('abort', abort, { once: true })
      try {
        options.signal.throwIfAborted()
        peer = await connectCodex(context, options.signal)
        options.signal.throwIfAborted()
        if (!(await codexAccount(peer)))
          throw new Error('Sign in with ChatGPT in Settings. API-key accounts are not accepted.')
        const started = await peer.request('thread/start', {
          cwd: context.cwd,
          ephemeral: true,
          environments: [],
          selectedCapabilityRoots: [],
          approvalPolicy: 'untrusted',
          sandbox: 'read-only',
          baseInstructions: DEFAULT_SYSTEM_PROMPT,
          dynamicTools: tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            deferLoading: false,
          })),
        })
        const thread = object(started['thread'])
        if (
          !Array.isArray(thread['environments']) ||
          thread['environments'].length !== 0 ||
          !Array.isArray(started['runtimeWorkspaceRoots']) ||
          started['runtimeWorkspaceRoots'].length !== 0 ||
          !Array.isArray(started['instructionSources']) ||
          started['instructionSources'].length !== 0
        )
          throw new Error('Unsupported Codex isolation configuration.')
        const threadId = thread['id']
        if (typeof threadId !== 'string') throw new Error('Invalid thread id.')
        const activePeer = peer
        const activeTurn: { id?: string } = {}
        let settled = false
        const done = new Promise<void>((resolve, reject) => {
          const finish = (error?: Error) => {
            if (settled) return
            settled = true
            if (error) reject(error)
            else resolve()
          }
          activePeer.onClose = (error) => {
            runController.abort()
            finish(error)
          }
          timer = setTimeout(() => {
            activePeer.close(new Error('Subscription reply timed out.'))
          }, 180000)
          activePeer.onRequest = async (method, params) => {
            if (
              settled ||
              method !== 'item/tool/call' ||
              params['threadId'] !== threadId ||
              (activeTurn.id && params['turnId'] !== activeTurn.id) ||
              params['namespace'] != null ||
              typeof params['tool'] !== 'string'
            )
              throw new Error('Denied runtime request.')
            const result = await bridge.call(params['tool'], object(params['arguments']))
            return {
              contentItems: [{ type: 'inputText', text: result.content }],
              success: !result.isError,
            }
          }
          activePeer.onNotification = (method, params) => {
            if (
              settled ||
              options.signal.aborted ||
              params['threadId'] !== threadId ||
              (activeTurn.id && params['turnId'] && params['turnId'] !== activeTurn.id)
            )
              return
            if (method === 'item/agentMessage/delta' && typeof params['delta'] === 'string')
              bridge.delta(params['delta'])
            if (method === 'turn/completed') {
              const turn = object(params['turn'])
              if (turn['status'] === 'completed') finish()
              else finish(new Error(providerFailure(turn['error'])))
            }
            if (method === 'error') finish(new Error(providerFailure(params)))
          }
        })
        // Attach rejection handling before turn/start, since notifications can arrive first.
        void done.catch(() => {})
        const turn = await peer.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: transcriptPrompt(conversation), text_elements: [] }],
        })
        const id = object(turn['turn'])['id']
        if (typeof id !== 'string') throw new Error('Invalid turn id.')
        activeTurn.id = id
        await done
        bridge.flush()
        return { conversation: structuredClone(bridge.history), stopReason: 'end_turn' }
      } catch (error) {
        const code = options.signal.aborted ? 'aborted' : 'api'
        options.onEvent({
          type: 'error',
          code,
          message: options.signal.aborted
            ? 'Reply stopped.'
            : error instanceof Error
              ? error.message
              : 'Subscription runtime failed.',
        })
        bridge.flush()
        return { conversation: structuredClone(bridge.history), stopReason: code }
      } finally {
        runController.abort()
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
        peer?.close()
      }
    },
  }
}

function providerFailure(value: unknown): string {
  const text = JSON.stringify(value)
  if (/usage|limit|quota|429/i.test(text))
    return 'Subscription usage limit reached. Wait for your allowance to reset or check your plan.'
  if (/auth|expired|401|unauthorized/i.test(text))
    return 'Subscription sign-in expired. Sign in again in Settings.'
  return 'Subscription request failed. Check sign-in, plan availability, and network access.'
}

export async function codexLogin(
  peer: RpcPeer,
  openUrl: (url: string) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  let loginId: string | undefined
  const abort = () => {
    if (loginId)
      void peer
        .request('account/login/cancel', { loginId })
        .finally(() => {
          peer.close()
        })
        .catch(() => {})
    else peer.close()
  }
  signal.addEventListener('abort', abort, { once: true })
  let timer: NodeJS.Timeout | undefined
  try {
    signal.throwIfAborted()
    let completed: (params: RpcObject) => void = () => {}
    const done = new Promise<void>((resolve, reject) => {
      completed = (params) => {
        if (params['success'] === true) resolve()
        else reject(new Error('Sign-in failed or cancelled.'))
      }
      peer.onClose = reject
      timer = setTimeout(() => {
        abort()
        reject(new Error('Sign-in timed out.'))
      }, 120000)
    })
    void done.catch(() => {})
    peer.onNotification = (method, params) => {
      if (method === 'account/login/completed' && (!loginId || params['loginId'] === loginId))
        completed(params)
    }
    const response = await peer.request('account/login/start', { type: 'chatgpt' })
    if (typeof response['loginId'] !== 'string' || typeof response['authUrl'] !== 'string')
      throw new Error('Invalid sign-in response.')
    loginId = response['loginId']
    const url = new URL(response['authUrl'])
    if (
      url.protocol !== 'https:' ||
      !['auth.openai.com', 'chatgpt.com'].includes(url.hostname) ||
      url.username ||
      url.password
    )
      throw new Error('Unexpected sign-in URL.')
    await openUrl(url.href)
    await done
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    peer.close()
  }
}
