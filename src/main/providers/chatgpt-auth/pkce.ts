import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes, base64url: a PKCE verifier (43 characters), state or nonce. */
export const randomValue = (): string => randomBytes(32).toString('base64url')

/** The S256 code challenge: base64url SHA-256 of the verifier, without padding. */
export const codeChallenge = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url')

/** Constant-time string comparison; hashing first makes the lengths equal. */
export function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest()
  return timingSafeEqual(digest(a), digest(b))
}
