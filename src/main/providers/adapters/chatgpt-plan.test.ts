import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProviderLoginState, ProviderStatus } from '../../../shared/ipc'
import type { AgentEvent } from '../../agent'
import { fakeServer, redirectFetch, type FakeServer } from '../../llm/openai-compat/test-support'
import { MANAGE_USAGE_URL, toolFormatMessage } from '../../llm/openai-responses'
import { makeSandbox, put, type Sandbox } from '../../permissions/test-support'
import { createKeyStore, type SafeStorage } from '../../secrets'
import { openSettingsStore, type SettingsStore } from '../../storage/settings-store'
import { toolHarness } from '../../tools/test-support'
import { startFakeOpenAi, type FakeOpenAi } from '../chatgpt-auth/fake-openai'
import { openChatgptAuth } from '../chatgpt-auth/service'
import { ConnectionService } from '../service'
import { chatgptPlanAdapter } from './chatgpt-plan'

/** Reversible but not plain text, so a token saved unencrypted would be found. */
const safeStorage: SafeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`enc:${Buffer.from(value).toString('base64')}`),
  decryptString: (data) => Buffer.from(data.toString().slice(4), 'base64').toString(),
}

const ID = 'chatgpt-plan'
const SIGN_IN_AGAIN = 'Your ChatGPT sign-in has ended. Sign in with ChatGPT again.'

let oauth: FakeOpenAi
let api: FakeServer
let sb: Sandbox
let dir: string
let settings: SettingsStore
let clock: number
let logs: string[]
let loginStates: ProviderLoginState[]
/** Every status, failure and error the tests saw, for the no-secret check. */
let observed: unknown[]
/** Requests to POST /v1/responses answer in order (the last repeats); GET /v1/models lists. */
let responses: ((res: ServerResponse) => void)[]
/** The entries GET /v1/models lists. */
let listed: Record<string, unknown>[]

const sse =
  (...events: unknown[]) =>
  (res: ServerResponse) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of events) res.write(`event: x\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  }
const jsonReply =
  (status: number, body: unknown) =>
  (res: ServerResponse): void => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_123' })
    res.end(JSON.stringify(body))
  }
const text = (value: string) => [
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: value, annotations: [] }],
    },
  },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
]
const call = (name: string, args: unknown) => [
  {
    type: 'response.output_item.done',
    output_index: 0,
    item: {
      type: 'function_call',
      id: 'fc_1',
      status: 'completed',
      call_id: 'call_1',
      name,
      namespace: 'workspace',
      arguments: JSON.stringify(args),
    },
  },
  { type: 'response.completed', response: { id: 'resp_1', status: 'completed' } },
]

beforeEach(async () => {
  oauth = await startFakeOpenAi()
  api = await fakeServer()
  sb = await makeSandbox()
  dir = await mkdtemp(path.join(tmpdir(), 'chatgpt-plan-'))
  settings = await openSettingsStore(path.join(dir, 'settings.json'))
  clock = Date.now()
  logs = []
  loginStates = []
  observed = []
  responses = [sse(...text('Hello'))]
  listed = [
    { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
    { slug: 'gpt-6.1-terra', display_name: 'GPT-6.1 Terra', visibility: 'list' },
    { slug: 'hidden-model', display_name: 'Hidden', visibility: 'hide' },
  ]
  api.reply((req, res) => {
    if (req.method === 'GET' && req.path === '/v1/models') {
      jsonReply(200, {
        models: listed,
      })(res)
      return
    }
    const next = responses.length > 1 ? responses.shift() : responses[0]
    next?.(res)
  })
})
afterEach(async () => {
  await oauth.close()
  await api.close()
  await sb.cleanup()
  await rm(dir, { recursive: true, force: true })
})

function connections(openUrl: (url: string) => Promise<void> = oauth.openUrl) {
  const keys = createKeyStore({ userDataPath: dir, safeStorage })
  return new ConnectionService(dir, openUrl, {
    settings,
    keys,
    onLoginState: (state) => loginStates.push(state),
    adapters: [
      chatgptPlanAdapter({
        auth: (host) =>
          openChatgptAuth(
            {
              keys,
              settings: host.settings ?? settings,
              log: (line) => logs.push(line),
              now: () => clock,
              sleep: () => Promise.resolve(),
            },
            oauth.endpoints,
          ),
        fetch: redirectFetch(api.origin),
        log: (line) => logs.push(line),
      }),
    ],
  })
}

async function signedIn() {
  const service = connections()
  const status = await service.login(ID)
  observed.push(status)
  expect(status).toMatchObject({ provider: ID, state: 'ready', signedIn: true })
  return service
}

async function send(service: ConnectionService, prompt = 'What is in my folder?') {
  const events: AgentEvent[] = []
  const tools = Object.values(toolHarness(sb).tools)
  let runner
  try {
    runner = await service.runner(ID, tools)
  } catch (thrown) {
    // What ChatSession does when a runner cannot start (services.ts createRunner).
    const failure = service.failure(ID, thrown)
    observed.push(thrown, failure)
    return { events, result: null, error: { type: 'error' as const, ...failure } }
  }
  const result = await runner.run([{ role: 'user', content: prompt }], {
    signal: new AbortController().signal,
    requestApproval: () => Promise.resolve(false),
    onEvent: (event) => events.push(event),
  })
  observed.push(events, result)
  return { events, result, error: events.find((event) => event.type === 'error') }
}

const responsesRequests = () =>
  api.requests.filter((req) => req.method === 'POST' && req.path === '/v1/responses')
const bearers = () => api.requests.map((req) => req.headers.authorization ?? '')

/** Everything secret the fake OAuth server issued or received. */
function secrets(): string[] {
  const found = new Set<string>(oauth.issuedIdTokens)
  for (const form of oauth.tokenRequests)
    for (const key of ['code', 'code_verifier', 'refresh_token'])
      if (form.get(key)) found.add(form.get(key) as string)
  const current = oauth.currentRefreshToken()
  if (current) found.add(current)
  for (const bearer of bearers()) if (bearer) found.add(bearer.replace(/^Bearer /, ''))
  return [...found]
}

async function expectNoSecrets(): Promise<void> {
  const haystacks = [
    JSON.stringify(observed),
    JSON.stringify(loginStates),
    observed
      .map((value) => (value instanceof Error ? `${value.message} ${value.stack ?? ''}` : ''))
      .join(),
    logs.join('\n'),
    await readFile(path.join(dir, 'settings.json'), 'utf8').catch(() => ''),
    await readFile(path.join(dir, 'secrets', 'chatgpt-plan.enc'), 'utf8').catch(() => ''),
  ]
  const all = secrets()
  expect(all.length).toBeGreaterThan(0)
  for (const secret of all) for (const text of haystacks) expect(text).not.toContain(secret)
  // Nothing token-shaped at all (JWTs start with a base64url JSON header).
  for (const text of haystacks.slice(0, 5)) expect(text).not.toMatch(/eyJ[\w-]+\.[\w-]+/)
}

describe('ChatGPT plan connection', () => {
  it('signs in through main and reports only the sign-in state', async () => {
    const service = connections()
    expect(await service.status(ID)).toMatchObject({ state: 'signed-out', signedIn: false })
    const status = await signedIn()
    expect(await status.status(ID)).toMatchObject({ state: 'ready', signedIn: true })
    expect(loginStates.at(0)).toEqual({ provider: ID, active: true, url: null, result: null })
    expect(loginStates.at(-1)).toMatchObject({ provider: ID, active: false })
    // The authorize request went out from main with PKCE; nothing about it reached a URL here.
    expect(oauth.authorizeRequests[0]?.get('code_challenge_method')).toBe('S256')
    expect(loginStates.every((state) => state.url === null)).toBe(true)
    // Settings keep only the registration (host id, client id): no token.
    const saved = JSON.parse(await readFile(path.join(dir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >
    expect(Object.keys(saved['chatgptAuth'] as object).sort()).toEqual([
      'accounts',
      'current',
      'hostId',
    ])
    await send(status)
    await expectNoSecrets()
  })

  it('cancels a sign-in that is waiting for the browser, and saves nothing', async () => {
    let opened!: () => void
    const waiting = new Promise<void>((resolve) => (opened = resolve))
    // The "browser" never comes back: the listener waits until Cancel.
    const service = connections(() => {
      opened()
      return Promise.resolve()
    })
    const login = service.login(ID)
    await waiting
    expect(service.loginState()).toMatchObject({ provider: ID, active: true })
    service.cancelLogin()
    const status = await login
    observed.push(status)
    expect(status).toEqual({ provider: ID, state: 'error', message: 'Sign-in cancelled.' })
    expect(oauth.tokenRequests).toHaveLength(0)
    expect(await readdir(path.join(dir, 'secrets')).catch(() => [])).toEqual([])
    expect(await service.status(ID)).toMatchObject({ state: 'signed-out' })
  })

  it('lists the plan’s models in the server’s order and saves a choice', async () => {
    const service = await signedIn()
    const models = await service.models(ID)
    expect(models.options.map((model) => model.id)).toEqual(['gpt-6.1-sol', 'gpt-6.1-terra'])
    expect(models).toMatchObject({ defaultModel: 'gpt-6.1-sol', selectedModel: 'gpt-6.1-sol' })
    await service.setModel(ID, 'gpt-6.1-terra')
    expect(settings.selection(ID)).toBe('gpt-6.1-terra')
    await send(service)
    expect(responsesRequests()[0]?.body).toMatchObject({ model: 'gpt-6.1-terra' })
    // No usage report exists for plan use.
    expect(await service.allowance(ID)).toMatchObject({ state: 'unknown', windows: [] })
    await expect(service.setModel(ID, 'hidden-model')).rejects.toThrow(
      'Choose an available ChatGPT model.',
    )
  })

  it('sends images only to a model the list says reads them, else to a documented model', async () => {
    listed = [
      { slug: 'gpt-4o', display_name: 'GPT-4o', visibility: 'list', input_modalities: ['text'] },
      {
        slug: 'gpt-6.1-sol',
        display_name: 'GPT-6.1 Sol',
        visibility: 'list',
        input_modalities: ['text', 'image'],
      },
      { slug: 'codex-mini-evil', display_name: 'Lookalike', visibility: 'list' },
      { slug: 'gpt-4o-text', display_name: 'Lookalike', visibility: 'list' },
      { slug: 'codex-mini-latest', display_name: 'Codex mini', visibility: 'list' },
    ]
    const service = await signedIn()
    expect((await service.models(ID)).options.map((o) => [o.id, o.imageInput])).toEqual([
      ['gpt-4o', false],
      ['gpt-6.1-sol', true],
      ['codex-mini-evil', undefined],
      ['gpt-4o-text', undefined],
      ['codex-mini-latest', undefined],
    ])
    const visionOf = async (model: string) => {
      await service.setModel(ID, model)
      return service.vision(ID)
    }
    // The list's text-only wins over a documented family that reads images.
    expect(await visionOf('gpt-4o')).toMatchObject({ enabled: false, source: 'model' })
    expect(await visionOf('gpt-6.1-sol')).toMatchObject({ enabled: true, source: 'model' })
    // No word from the list: a documented id decides; a lookalike is unknown, so no images.
    expect(await visionOf('codex-mini-latest')).toMatchObject({ enabled: true, source: 'model' })
    for (const lookalike of ['codex-mini-evil', 'gpt-4o-text'])
      expect([lookalike, await visionOf(lookalike)]).toEqual([
        lookalike,
        expect.objectContaining({ enabled: false, source: 'setting' }),
      ])
  })

  it('runs a tool round trip on a granted folder with the namespaced, non-strict tools', async () => {
    await put(path.join(sb.root, 'alpha.txt'), 'a')
    await put(path.join(sb.root, 'beta.md'), 'b')
    const service = await signedIn()
    responses = [sse(...call('list_dir', { path: sb.root })), sse(...text('alpha.txt and beta.md'))]
    const { result, events } = await send(service)
    expect(result?.stopReason).toBe('end_turn')
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'tool_use', name: 'list_dir', input: { path: sb.root } }),
    )
    const [first, second] = responsesRequests()
    const offered = (first?.body as { tools: { type: string; name: string; tools: unknown[] }[] })
      .tools
    expect(offered).toHaveLength(1)
    expect(offered[0]).toMatchObject({ type: 'namespace', name: 'workspace' })
    expect(offered[0]?.tools).toContainEqual(
      expect.objectContaining({ type: 'function', name: 'list_dir', strict: false }),
    )
    const output = (second?.body as { input: { type: string; output?: string }[] }).input.find(
      (item) => item.type === 'function_call_output',
    )
    expect(output?.output).toContain('alpha.txt')
    expect(output?.output).toContain('beta.md')
    // Both requests carry the same access token, only ever as the Authorization header.
    expect(new Set(bearers().filter((b) => b.startsWith('Bearer ')))).toHaveProperty('size', 1)
    await expectNoSecrets()
  })

  it('pauses at the turn limit saved in Settings, with the progress kept', async () => {
    const service = await signedIn()
    await settings.setTurnLimit(5)
    // Every response asks for a tool, so only the limit ends the run.
    responses = [sse(...call('list_dir', { path: sb.root }))]
    const { result, error } = await send(service)
    expect(result?.stopReason).toBe('max_turns')
    expect(responsesRequests()).toHaveLength(5)
    expect(error).toMatchObject({
      code: 'max_turns',
      message: 'Paused after 5 steps. Your progress is saved.',
    })
    // The prompt, then five answered calls: nothing left unpaired to continue from.
    expect(result?.conversation.map((m) => m.role)).toEqual([
      'user',
      ...Array<string[]>(5).fill(['assistant', 'user']).flat(),
    ])
  })

  it('refreshes an access token near expiry before the request', async () => {
    const service = await signedIn()
    await send(service)
    const before = bearers().at(-1)
    clock += 3600 * 1000
    await send(service)
    expect(oauth.tokenRequests.map((form) => form.get('grant_type'))).toEqual([
      'authorization_code',
      'refresh_token',
    ])
    expect(bearers().at(-1)).not.toBe(before)
    await expectNoSecrets()
  })

  it('says to sign in again when the sign-in has ended', async () => {
    const service = await signedIn()
    oauth.options.refreshReply = () => ({ status: 400, body: { error: 'invalid_grant' } })
    clock += 3600 * 1000
    const { error } = await send(service)
    expect(error).toMatchObject({ code: 'auth_expired', message: SIGN_IN_AGAIN })
    expect(responsesRequests()).toHaveLength(0)
    const status = await service.status(ID)
    observed.push(status)
    expect(status).toMatchObject({
      state: 'signed-out',
      signedIn: false,
      failure: { code: 'auth_expired' },
    })
    await expectNoSecrets()
  })

  it('says to sign in again when OpenAI refuses the token, until the next sign-in', async () => {
    const service = await signedIn()
    responses = [jsonReply(401, { detail: 'token eyJhbGciOi.leak.sig rejected' })]
    const { error } = await send(service)
    expect(error).toMatchObject({ code: 'auth_expired' })
    expect(error && 'message' in error ? error.message : '').not.toContain('leak')
    expect(await service.status(ID)).toMatchObject({ state: 'signed-out', signedIn: false })
    await service.login(ID)
    expect(await service.status(ID)).toMatchObject({ state: 'ready' })
  })

  it.each([
    [
      'needs Plus or Pro',
      403,
      'subscription_sharing_user_not_eligible',
      'plan_not_entitled',
      /^Needs ChatGPT Plus or Pro\. On other plans, use Codex · ChatGPT/,
    ],
    [
      'limit reached, with the Manage usage link',
      429,
      'subscription_sharing_usage_limit_exceeded',
      'usage_limit',
      new RegExp(MANAGE_USAGE_URL.replaceAll('.', '\\.')),
    ],
  ])('maps %s', async (_name, status, code, expected, message) => {
    const service = await signedIn()
    responses = [jsonReply(status, { error: { code, message: 'provider SECRET text' } })]
    const { error } = await send(service)
    expect(error).toMatchObject({ code: expected })
    const shown = error && 'message' in error ? error.message : ''
    expect(shown).toMatch(message)
    // The adapter's own wording keeps the client's diagnostics.
    expect(shown).toContain(
      `Details: HTTP ${String(status)}, application/json, code ${code}, request req_123.`,
    )
    expect(shown).not.toContain('SECRET')
    expect(service.failure(ID, new Error('provider SECRET text')).message).not.toContain('SECRET')
    if (expected === 'plan_not_entitled')
      expect(await service.status(ID)).toMatchObject({
        state: 'not-entitled',
        availability: 'blocked',
      })
    await expectNoSecrets()
  })

  it.each([
    ['an invalid tool type', 400, 'invalid_value', 'tools[0].type'],
    ['a non-strict function', 400, null, 'tools[0].tools[2].strict'],
    ['an unsupported capability', 400, 'subscription_sharing_unsupported_capability', 'tools'],
    ['a replayed call namespace', 400, 'invalid_value', 'input[2].namespace'],
  ])('reports a rejection of %s as a tool-format error', async (_name, status, code, param) => {
    const service = await signedIn()
    responses = [
      jsonReply(status, {
        error: { type: 'invalid_request_error', code, param, message: 'Invalid value: SECRET' },
      }),
    ]
    const { error } = await send(service)
    expect(error).toMatchObject({ code: 'invalid_request' })
    const shown = error && 'message' in error ? error.message : ''
    expect(shown.startsWith(toolFormatMessage(param))).toBe(true)
    expect(shown).toContain(`param ${param}, request req_123.`)
    expect(logs).toContain(`chatgpt-plan: tool format rejected (param=${param}, request=req_123)`)
    expect(logs.join('\n')).not.toContain('SECRET')
  })

  it('does not treat an unrelated bad request as a tool-format error', async () => {
    const service = await signedIn()
    responses = [jsonReply(400, { error: { code: 'invalid_value', param: 'model' } })]
    const { error } = await send(service)
    expect(error).toMatchObject({ code: 'invalid_request' })
    expect(error && 'message' in error ? error.message : '').not.toContain('tool format')
  })

  it('signs out and deletes the stored tokens when forgotten', async () => {
    const service = await signedIn()
    expect(await readdir(path.join(dir, 'secrets'))).toEqual(['chatgpt-plan.enc'])
    expect(await service.forget(ID)).toBeNull()
    expect(oauth.revokeRequests).toHaveLength(1)
    expect(await readdir(path.join(dir, 'secrets'))).toEqual([])
    expect(await service.status(ID)).toMatchObject({ state: 'signed-out' })
    const { error } = await send(service)
    expect(error).toMatchObject({ code: 'authentication' })
  })

  it('reports a sign-out OpenAI did not confirm, and still deletes the tokens', async () => {
    const service = await signedIn()
    oauth.options.revokeReply = () => ({ status: 400 })
    const note = await service.forget(ID)
    expect(note).toMatch(/couldn't confirm sign-out at OpenAI/)
    expect(await readdir(path.join(dir, 'secrets'))).toEqual([])
  })

  it('reports status without a network request', async () => {
    const service = await signedIn()
    const before = api.requests.length + oauth.tokenRequests.length
    const statuses: ProviderStatus[] = [await service.status(ID), await service.status(ID)]
    expect(statuses.every((status) => status.state === 'ready')).toBe(true)
    expect(api.requests.length + oauth.tokenRequests.length).toBe(before)
  })
})
