import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto'
import { CLOCK_TOLERANCE } from './config'
import { ChatgptAuthError } from './errors'
import { safeEqual } from './pkce'

/** The verified claims the app keeps. */
export interface IdTokenClaims {
  sub: string
  email?: string
}

export interface IdTokenExpectations {
  issuer: string
  /** The issued client id: the token's audience. */
  clientId: string
  /** This attempt's nonce. Refreshed ID tokens are checked without one. */
  nonce?: string
  now: number
}

/**
 * The issuer's signing keys, fetched from the discovered jwks_uri. Cached; fetched
 * again (at most once a minute) when a token names a key id it has not seen, so a
 * key rotation does not break sign-in.
 */
export class Jwks {
  private keys = new Map<string, KeyObject>()
  private unnamed: KeyObject[] = []
  private fetchedAt: number | undefined

  constructor(
    private readonly load: () => Promise<unknown>,
    private readonly now: () => number,
  ) {}

  async find(kid: string | undefined): Promise<KeyObject[]> {
    const lookup = () =>
      kid === undefined ? [...this.keys.values(), ...this.unnamed] : [this.keys.get(kid)]
    let found = lookup().filter((key) => key !== undefined)
    if (
      found.length === 0 &&
      (this.fetchedAt === undefined || this.now() - this.fetchedAt > 60_000)
    ) {
      await this.refresh()
      found = lookup().filter((key) => key !== undefined)
    }
    return found
  }

  private async refresh(): Promise<void> {
    const document = await this.load()
    this.fetchedAt = this.now()
    const list = (document as { keys?: unknown } | undefined)?.keys
    if (!Array.isArray(list)) throw new ChatgptAuthError('discovery')
    const keys = new Map<string, KeyObject>()
    const unnamed: KeyObject[] = []
    for (const jwk of list as unknown[]) {
      const key = rsaSigningKey(jwk)
      if (!key) continue
      const kid = (jwk as { kid?: unknown }).kid
      if (typeof kid === 'string') keys.set(kid, key)
      else unnamed.push(key)
    }
    this.keys = keys
    this.unnamed = unnamed
  }
}

/** An RSA key meant for RS256 signatures, at least 2048 bits; anything else is skipped. */
function rsaSigningKey(jwk: unknown): KeyObject | undefined {
  if (typeof jwk !== 'object' || jwk === null) return undefined
  const { kty, use, alg } = jwk as Record<string, unknown>
  if (kty !== 'RSA' || (use !== undefined && use !== 'sig')) return undefined
  if (alg !== undefined && alg !== 'RS256') return undefined
  try {
    const key = createPublicKey({ key: jwk as JsonWebKey, format: 'jwk' })
    const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
    return key.asymmetricKeyType === 'rsa' && bits >= 2048 ? key : undefined
  } catch {
    return undefined
  }
}

function decodeSegment(segment: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new ChatgptAuthError('invalid-id-token')
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as unknown
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch {
    throw new ChatgptAuthError('invalid-id-token')
  }
}

/**
 * Verifies an ID token with Node's crypto: RS256 signature against the issuer's
 * JWKS, then iss, aud (and azp when there are several audiences), exp, nbf, iat,
 * nonce and sub. Throws ChatgptAuthError('invalid-id-token') on any failure.
 */
export async function verifyIdToken(
  token: string,
  jwks: Jwks,
  expected: IdTokenExpectations,
): Promise<IdTokenClaims> {
  const fail = (): never => {
    throw new ChatgptAuthError('invalid-id-token')
  }
  const parts = token.split('.')
  if (parts.length !== 3) fail()
  const [headerPart = '', payloadPart = '', signaturePart = ''] = parts
  const header = decodeSegment(headerPart)
  if (header['alg'] !== 'RS256') fail()
  if (header['crit'] !== undefined) fail()
  const kid = header['kid']
  if (kid !== undefined && typeof kid !== 'string') fail()
  if (!/^[A-Za-z0-9_-]+$/.test(signaturePart)) fail()

  const keys = await jwks.find(kid as string | undefined)
  const signed = Buffer.from(`${headerPart}.${payloadPart}`, 'ascii')
  const signature = Buffer.from(signaturePart, 'base64url')
  if (!keys.some((key) => verify('sha256', signed, key, signature))) fail()

  const claims = decodeSegment(payloadPart)
  const seconds = (name: string): number | undefined => {
    const value = claims[name]
    if (value === undefined) return undefined
    return typeof value === 'number' && Number.isFinite(value) ? value * 1000 : fail()
  }
  if (claims['iss'] !== expected.issuer) fail()
  const aud = claims['aud']
  const audiences = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : []
  if (!audiences.includes(expected.clientId)) fail()
  if (audiences.length > 1 && claims['azp'] !== expected.clientId) fail()
  const exp = seconds('exp') ?? fail()
  const iat = seconds('iat') ?? fail()
  const nbf = seconds('nbf')
  if (exp <= expected.now - CLOCK_TOLERANCE) fail()
  if (iat > expected.now + CLOCK_TOLERANCE) fail()
  if (nbf !== undefined && nbf > expected.now + CLOCK_TOLERANCE) fail()
  if (expected.nonce !== undefined) {
    const nonce = claims['nonce']
    if (typeof nonce !== 'string' || !safeEqual(nonce, expected.nonce)) fail()
  }
  const sub = claims['sub']
  if (typeof sub !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(sub)) return fail()
  const email = claims['email']
  return typeof email === 'string' && email.length <= 320 ? { sub, email } : { sub }
}
