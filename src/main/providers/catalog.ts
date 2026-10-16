import type { ProviderAllowance, ProviderModel, ProviderModels } from '../../shared/ipc'
import { SubscriptionError, plausibleReset } from './errors'
import { object, type RpcPeer } from './rpc'

/** Documented Free/Go compatible fallback; never invent access when a catalog excludes it. */
export const FREE_CODEX_MODEL = 'gpt-5.6-terra'
const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)

export async function codexModels(
  peer: RpcPeer,
  savedModel: string | null,
): Promise<ProviderModels> {
  const options: ProviderModel[] = []
  const cursors = new Set<string>()
  let cursor: string | null = null
  const deadline = performance.now() + 1500
  do {
    if (performance.now() >= deadline) throw new Error('Runtime model catalog timed out.')
    const result = await peer.request(
      'model/list',
      { includeHidden: false, cursor, limit: 100 },
      { timeoutMs: Math.max(1, deadline - performance.now()), closeOnTimeout: false },
    )
    if (!Array.isArray(result['data'])) throw new Error('Invalid runtime model catalog.')
    for (const value of result['data']) {
      const model = object(value)
      if (model['hidden'] === true || !identifier(model['model'])) continue
      const efforts = Array.isArray(model['supportedReasoningEfforts'])
        ? model['supportedReasoningEfforts']
            .map((entry) => object(entry)['reasoningEffort'])
            .filter(identifier)
        : []
      options.push({
        id: model['model'],
        // Use only safe catalog labels, never arbitrary provider text.
        label:
          typeof model['displayName'] === 'string' &&
          /^[\w .()+-]{1,100}$/.test(model['displayName'])
            ? model['displayName']
            : model['model'],
        defaultReasoningEffort: identifier(model['defaultReasoningEffort'])
          ? model['defaultReasoningEffort']
          : null,
        supportedReasoningEfforts: efforts,
        isDefault: model['isDefault'] === true,
      })
    }
    cursor = typeof result['nextCursor'] === 'string' ? result['nextCursor'] : null
    if (cursor && (cursors.has(cursor) || cursors.size >= 20))
      throw new Error('Invalid runtime model pagination.')
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const defaultModel =
    options.find((model) => model.isDefault)?.id ??
    options.find((model) => model.id === FREE_CODEX_MODEL)?.id ??
    options[0]?.id ??
    null
  if (!defaultModel)
    throw new SubscriptionError(
      'model_unavailable',
      'No models are available for this account. Check your plan in Settings.',
    )
  return {
    provider: 'codex-subscription',
    options,
    savedModel,
    defaultModel,
    selectedModel: options.some((model) => model.id === savedModel) ? savedModel : defaultModel,
    resolvedModel: null,
  }
}

/** A user-facing name for a window length, or null when the runtime gave none we can use. */
export function windowLabel(minutes: unknown): string | null {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes <= 0) return null
  if (minutes === 7 * 24 * 60) return 'weekly limit'
  if (minutes % (24 * 60) === 0) return `${String(minutes / (24 * 60))}-day limit`
  if (minutes % 60 === 0) return `${String(minutes / 60)}-hour limit`
  return null
}

const creditsOf = (snapshot: Record<string, unknown>): Record<string, unknown> | null =>
  snapshot['credits'] && typeof snapshot['credits'] === 'object'
    ? object(snapshot['credits'])
    : null

export async function codexAllowance(peer: RpcPeer): Promise<ProviderAllowance> {
  const result = await peer.request(
    'account/rateLimits/read',
    { excludeResetCreditDetails: true },
    { timeoutMs: 1500, closeOnTimeout: false },
  )
  const current = object(result['rateLimits'])
  const buckets =
    result['rateLimitsByLimitId'] && typeof result['rateLimitsByLimitId'] === 'object'
      ? Object.entries(object(result['rateLimitsByLimitId']))
      : []
  const snapshots = buckets.length
    ? buckets
    : [[identifier(current['limitId']) ? current['limitId'] : 'codex', current] as const]
  const windows: ProviderAllowance['windows'] = []
  // Only backend permission determines ordinary usage. Percentages/reset dates are display data.
  const credits =
    current['credits'] && typeof current['credits'] === 'object' ? object(current['credits']) : {}
  const hasCredits = credits['hasCredits'] === true || credits['unlimited'] === true
  // Display only: the aggregate snapshot plus each bucket, so credits reported on a bucket show.
  const displayCredits = [current, ...snapshots.map(([, value]) => object(value))]
    .map(creditsOf)
    .filter((entry) => entry !== null)
  const state =
    hasCredits || result['ordinaryUsageAllowed'] === true
      ? 'available'
      : result['ordinaryUsageAllowed'] === false
        ? 'limited'
        : 'unknown'
  for (const [id, value] of snapshots) {
    const snapshot = object(value)
    for (const name of ['primary', 'secondary']) {
      if (!snapshot[name]) continue
      const window = object(snapshot[name])
      const used = window['usedPercent']
      if (typeof used !== 'number' || !Number.isFinite(used)) continue
      const reset = window['resetsAt']
      const label = windowLabel(window['windowDurationMins'])
      windows.push({
        limitId: `${identifier(id) ? id : 'codex'}:${name}`,
        remainingPercent: Math.max(0, Math.min(100, 100 - used)),
        resetsAt: plausibleReset(reset) ?? null,
        ...(label ? { label } : {}),
      })
    }
  }
  return {
    provider: 'codex-subscription',
    ...(displayCredits.length
      ? {
          credits: {
            hasCredits: displayCredits.some((entry) => entry['hasCredits'] === true),
            unlimited: displayCredits.some((entry) => entry['unlimited'] === true),
          },
        }
      : {}),
    plan: identifier(current['planType']) ? current['planType'] : null,
    state,
    resetsAt:
      state === 'limited'
        ? (windows
            .map((window) => window.resetsAt)
            .filter((reset): reset is string => reset !== null)
            .sort()
            .at(-1) ?? null)
        : null,
    windows,
    lastError: null,
  }
}
