/**
 * The only errors the sign-in service throws. Each message is fixed text, so no
 * token, code, server body or path can reach a caller, a log or the renderer
 * through one. No cause is attached for the same reason.
 */
const MESSAGES = {
  cancelled: 'Sign-in cancelled.',
  'timed-out': 'Sign-in timed out. Try again.',
  busy: 'A ChatGPT sign-in is already in progress.',
  browser: 'Could not open the browser for ChatGPT sign-in.',
  listener: 'Could not start the local sign-in listener.',
  'access-denied': 'ChatGPT sign-in was declined.',
  'state-mismatch': 'The sign-in response did not match this attempt. Try again.',
  'invalid-callback': 'ChatGPT returned an incomplete sign-in response. Try again.',
  'authorization-failed': 'ChatGPT sign-in failed. Try again.',
  'token-exchange': 'ChatGPT did not accept the sign-in. Try again.',
  'invalid-id-token': 'ChatGPT returned an identity that could not be verified.',
  'account-mismatch': 'ChatGPT signed in a different account than the one selected.',
  'plan-not-enabled':
    'ChatGPT plan use was not allowed for Desktop Agent. Sign in again and allow it to use your plan.',
  network: 'Could not reach OpenAI. Check your connection and try again.',
  server: 'OpenAI sign-in is unavailable right now. Try again later.',
  discovery: 'OpenAI returned an unexpected sign-in configuration.',
  'signed-out': 'Sign in with ChatGPT first.',
  'sign-in-again': 'Your ChatGPT sign-in has ended. Sign in again.',
  storage: 'Could not save the ChatGPT sign-in securely.',
} as const

export type ChatgptAuthErrorCode = keyof typeof MESSAGES

/** Errors worth retrying later without signing in again. */
const TRANSIENT: ReadonlySet<ChatgptAuthErrorCode> = new Set(['network', 'server'])

export class ChatgptAuthError extends Error {
  override readonly name = 'ChatgptAuthError'
  constructor(readonly code: ChatgptAuthErrorCode) {
    super(MESSAGES[code])
  }
  get transient(): boolean {
    return TRANSIENT.has(this.code)
  }
}

/** Token-shaped and credential-shaped text, for anything that is logged. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  // JWTs (access and ID tokens): three base64url segments, the first a JSON header.
  [/eyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[redacted]'],
  [/\bBearer\s+\S+/gi, 'Bearer [redacted]'],
  [
    /\b(access_token|refresh_token|id_token|id_token_hint|code|code_verifier|token|state|nonce)=[^&\s"']*/gi,
    '$1=[redacted]',
  ],
  [/"(access_token|refresh_token|id_token)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"'],
]

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((result, [pattern, value]) => result.replace(pattern, value), text)
}
