/**
 * Sign in with ChatGPT for open-source apps: OAuth 2.0 Authorization Code with
 * PKCE plus OpenID Connect, against OpenAI's production endpoints. See
 * https://developers.openai.com/siwc/token-sharing-open-source/sign-in.
 */

/** Where the flow talks to. Only tests use anything but PRODUCTION (see service.ts). */
export interface Endpoints {
  issuer: string
  authorize: string
  token: string
  /** The OpenID configuration: jwks_uri and revocation_endpoint come from here. */
  discovery: string
}

export const PRODUCTION: Endpoints = Object.freeze({
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  discovery: 'https://auth.openai.com/.well-known/openid-configuration',
})

/** The audience every access token is for. Sent with the authorization request, code exchange and refresh. */
export const RESOURCE = 'https://api.openai.com/v1'
/** Without this scope the tokens cannot use the ChatGPT plan, so sign-in does not proceed. */
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct'
export const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  PLAN_SCOPE,
] as const

/** The first-time registration entrypoint; never saved and never used to exchange a code. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'
/** Sent as agent_name_hint on first registration only, the same on every install. */
export const AGENT_NAME = 'Desktop Agent'
/** Only the port of the loopback redirect varies; scheme, host and path never do. */
export const CALLBACK_PATH = '/auth/callback'
/** The key-store id the credential record is saved under (userData/secrets/chatgpt-plan.enc). */
export const CREDENTIAL_ID = 'chatgpt-plan'

/** How long a sign-in waits for the browser to come back. */
export const LOGIN_TIMEOUT = 5 * 60 * 1000
/** Refresh this long before the access token expires (it lasts an hour). */
export const REFRESH_MARGIN = 5 * 60 * 1000
/** A token this close to expiry is not handed out, even when a refresh cannot happen yet. */
export const EXPIRY_SLACK = 30 * 1000
/** Clock skew allowed on ID-token exp, nbf and iat. */
export const CLOCK_TOLERANCE = 5 * 1000
/** Every request to OpenAI gives up after this long. */
export const REQUEST_TIMEOUT = 30 * 1000
