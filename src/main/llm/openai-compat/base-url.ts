import { OpenAICompatError } from './errors'

export type OpenAICompatFlavor = 'openai' | 'ollama' | 'lmstudio' | 'openrouter'

export const FLAVOR_LABELS: Record<OpenAICompatFlavor, string> = {
  openai: 'OpenAI',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  openrouter: 'OpenRouter',
}

/** Hosted flavors: the one official host, over https. Local flavors: loopback only, over http. */
const HOSTED: Partial<Record<OpenAICompatFlavor, { host: string; path: string }>> = {
  openai: { host: 'api.openai.com', path: '/v1' },
  openrouter: { host: 'openrouter.ai', path: '/api/v1' },
}
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost'])

export const DEFAULT_BASE_URLS: Record<OpenAICompatFlavor, string> = {
  openai: 'https://api.openai.com/v1',
  ollama: 'http://127.0.0.1:11434/v1',
  lmstudio: 'http://127.0.0.1:1234/v1',
  openrouter: 'https://openrouter.ai/api/v1',
}

/**
 * The validated API root, without a trailing slash (".../v1"). A bare origin gets the
 * flavor's default path. Throws `invalid_request` without echoing the rejected URL.
 */
export function resolveBaseUrl(baseUrl: string, flavor: OpenAICompatFlavor): URL {
  const label = FLAVOR_LABELS[flavor]
  const reject = (why: string): never => {
    throw new OpenAICompatError('invalid_request', `${label} base URL rejected: ${why}.`)
  }
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return reject('not a valid URL')
  }
  if (url.username || url.password) reject('credentials are not allowed in the URL')
  if (url.search || url.hash) reject('query strings and fragments are not allowed')
  const hosted = HOSTED[flavor]
  if (hosted) {
    if (url.protocol !== 'https:') reject('https is required')
    if (url.hostname !== hosted.host || url.port !== '')
      reject(`only ${hosted.host} is allowed for ${label}`)
  } else {
    if (url.protocol !== 'http:') reject('use http:// for a local server')
    if (!LOOPBACK.has(url.hostname)) reject('only 127.0.0.1, ::1 and localhost are allowed')
  }
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path === '' ? (hosted?.path ?? '/v1') : path
  return url
}

/** `${root}/${endpoint}`, staying on the validated origin. */
export function endpointUrl(root: URL, endpoint: string): string {
  return `${root.origin}${root.pathname}/${endpoint}`
}
