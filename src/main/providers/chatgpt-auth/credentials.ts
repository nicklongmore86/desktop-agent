import { z } from 'zod'

const token = z.string().min(1).max(16_384)
/** An issued client id (`oaiapp_…`); never the dynamic-registration entrypoint. */
export const clientIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,256}$/)
  .refine((id) => id !== 'dynamic_agent_client')

const tokensSchema = z.object({
  accessToken: token,
  refreshToken: token,
  tokenType: z.literal('Bearer'),
  /** Epoch milliseconds. */
  expiresAt: z.number(),
  earliestRefreshAt: z.number().optional(),
  scopes: z.array(z.string().max(128)).max(64),
})

/**
 * The credential record, one JSON document in the encrypted key store under
 * CREDENTIAL_ID. Every field is replaced together, so a rotated refresh token
 * is never saved without the access token and expiry it came with. The ID
 * token is verified and then discarded: it is never sent anywhere (no
 * id_token_hint, which would put it in a browser URL), so it is not kept.
 * Without `tokens` the record only remembers which account to sign in again;
 * `ended` says why the tokens were dropped.
 */
export const credentialSchema = z.object({
  version: z.literal(1),
  issuer: z.string().max(2048),
  subject: z.string().regex(/^[\x21-\x7e]{1,256}$/),
  email: z.string().max(320).optional(),
  clientId: clientIdSchema,
  hostId: z.string().max(256),
  tokens: tokensSchema.optional(),
  ended: z.enum(['expired', 'plan-not-enabled']).optional(),
  savedAt: z.string().max(64),
})

export type Credential = z.infer<typeof credentialSchema>
export type Tokens = z.infer<typeof tokensSchema>

/** Undefined for anything that is not a valid record; never says why, so nothing is echoed. */
export function parseCredential(text: string): Credential | undefined {
  try {
    const parsed = credentialSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

const tokenResponseSchema = z.object({
  access_token: token,
  refresh_token: token.optional(),
  id_token: token.optional(),
  token_type: z.string().regex(/^bearer$/i),
  expires_in: z
    .number()
    .positive()
    .max(366 * 24 * 3600),
  scope: z.string().max(4096).optional(),
  earliest_refresh_at: z.union([z.number(), z.string().max(64)]).optional(),
})
export type TokenResponse = z.infer<typeof tokenResponseSchema>

export function parseTokenResponse(json: unknown): TokenResponse | undefined {
  const parsed = tokenResponseSchema.safeParse(json)
  return parsed.success ? parsed.data : undefined
}

/**
 * earliest_refresh_at as epoch milliseconds. The docs name the field without a
 * format, so Unix seconds, milliseconds and ISO 8601 are all accepted; anything
 * else is ignored rather than blocking refresh.
 */
export function parseInstant(value: number | string | undefined): number | undefined {
  if (value === undefined) return undefined
  const numeric =
    typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN
  if (Number.isFinite(numeric)) return numeric > 1e12 ? numeric : numeric * 1000
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(parsed) ? parsed : undefined
}

export const parseScopes = (scope: string): string[] => scope.split(/\s+/).filter(Boolean)
