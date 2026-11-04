// An Electron main for the network layer's real-Electron tests: the built layer and clients
// (out/main/network.js) over real Chromium sessions, as the app wires them. The test drives it
// through `electronApp.evaluate` and `globalThis.network`. Run `pnpm build` first.
const { app, session } = require('electron')
const { join } = require('node:path')
const {
  apiErrorEvent,
  cloudFetch,
  createClaudeClient,
  createElectronTransports,
  createGeminiClient,
  createGuardedFetch,
  createOpenAICompatClient,
  geminiErrorEvent,
  installNetworkTransports,
  listOpenAICompatModels,
  localFetch,
  networkErrorMessage,
  openAICompatErrorEvent,
} = require(join(__dirname, '../../out/main/network.js'))

const failureOf = (error) => ({
  name: error?.name,
  kind: error?.kind,
  detail: error?.detail,
  message: error?.message,
})

/** Before the app is ready, a request must fail on its own, without touching Electron. */
const beforeReady = cloudFetch('https://api.openai.com/v1/models').then(
  () => ({ sent: true }),
  failureOf,
)

const logins = []
app.on('login', (event, _contents, _details, _authInfo, callback) => {
  logins.push('login')
  event.preventDefault()
  callback()
})

const PARAMS = { model: 'm', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }

app.whenReady().then(async () => {
  const transports = await createElectronTransports()
  installNetworkTransports(transports)
  /** The cloud session without the host list, so tests can use names the proxy answers for. */
  const anyHost = createGuardedFetch(
    () => true,
    () => transports.cloud,
  )
  const via = { any: anyHost, cloud: cloudFetch, local: localFetch, node: fetch }

  async function answer(through, url, init) {
    try {
      const response = await via[through](url, init)
      return { status: response.status, text: await response.text() }
    } catch (error) {
      return { failure: failureOf(error) }
    }
  }

  async function readAll(body) {
    const reader = body.getReader()
    const chunks = []
    const started = Date.now()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return chunks
      chunks.push({ at: Date.now() - started, text: Buffer.from(value).toString() })
    }
  }

  /** What a run's Stop does: abort after the first chunk. */
  async function abortAfterFirstChunk(through, url) {
    const controller = new AbortController()
    const response = await via[through](url, { signal: controller.signal })
    const reader = response.body.getReader()
    await reader.read()
    controller.abort()
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) return { ended: true }
      }
    } catch (error) {
      return { failure: failureOf(error) }
    }
  }

  /** What a size limit does: cancel the reader without any abort. */
  async function cancelAfterFirstChunk(through, url) {
    const response = await via[through](url)
    const reader = response.body.getReader()
    await reader.read()
    await reader.cancel()
    return { cancelled: true }
  }

  async function clientRun(stream, errorEvent) {
    const signal = new AbortController().signal
    const deltas = []
    const running = stream({ signal })
    running.on('text', (delta) => deltas.push(delta))
    try {
      const final = await running.finalMessage()
      return { deltas, text: final.content.map((block) => block.text ?? '').join('') }
    } catch (error) {
      return { deltas, event: errorEvent(error) }
    }
  }

  globalThis.network = {
    beforeReady: () => beforeReady,
    logins: () => [...logins],
    answer,
    stream: async (through, url) => readAll((await via[through](url)).body),
    abortAfterFirstChunk,
    cancelAfterFirstChunk,
    setDefaultSessionCookie: (url) =>
      session.defaultSession.cookies.set({ url, name: 'from-default', value: 'secret-cookie' }),
    cloudSessionCookies: () => session.fromPartition('network-cloud').cookies.get({}),
    resolveProxy: (partition, url) => session.fromPartition(partition).resolveProxy(url),
    claude: (key) =>
      clientRun(
        ({ signal }) => createClaudeClient(key).messages.stream(PARAMS, { signal }),
        apiErrorEvent,
      ),
    gemini: (key) =>
      clientRun(
        ({ signal }) =>
          createGeminiClient({ apiKey: key, model: 'gemini-test' }).messages.stream(PARAMS, {
            signal,
          }),
        geminiErrorEvent,
      ),
    compat: (options) =>
      clientRun(
        ({ signal }) =>
          createOpenAICompatClient({ ...options, model: 'm' }).messages.stream(PARAMS, { signal }),
        openAICompatErrorEvent,
      ),
    localModels: async (baseUrl) => {
      try {
        return { models: await listOpenAICompatModels({ flavor: 'ollama', baseUrl }) }
      } catch (error) {
        return { failure: failureOf(error) }
      }
    },
    messageFor: networkErrorMessage,
  }
})

app.on('window-all-closed', () => {})
