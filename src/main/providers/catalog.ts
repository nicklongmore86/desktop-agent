import type { ProviderAllowance, ProviderModel, ProviderModels } from '../../shared/ipc'
import { SubscriptionError } from './errors'
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
  do {
    const result = await peer.request('model/list', { includeHidden: false, cursor, limit: 100 })
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

export async function codexAllowance(
  peer: RpcPeer,
  selectedModel?: string | null,
): Promise<ProviderAllowance> {
  const result = await peer.request('account/rateLimits/read', { excludeResetCreditDetails: true })
  const current = object(result['rateLimits'])
  const buckets =
    result['rateLimitsByLimitId'] && typeof result['rateLimitsByLimitId'] === 'object'
      ? Object.entries(object(result['rateLimitsByLimitId']))
      : []
  const snapshots = buckets.length
    ? buckets
    : [[identifier(current['limitId']) ? current['limitId'] : 'codex', current] as const]
  const windows: ProviderAllowance['windows'] = []
  const matching = selectedModel
    ? snapshots.filter(([, value]) => object(value)['normalModelSlug'] === selectedModel)
    : []
  const relevant = matching.length
    ? matching.map(([, value]) => object(value))
    : !selectedModel || !current['normalModelSlug'] || current['normalModelSlug'] === selectedModel
      ? [current]
      : []
  let blocked = false
  let known = false
  let unknownReset = false
  const blockingResets: string[] = []
  for (const snapshot of relevant) {
    if (snapshot['spendControlReached'] === true) {
      blocked = true
      unknownReset = true
    }
    if (snapshot['rateLimitReachedType']) blocked = true
    for (const name of ['primary', 'secondary']) {
      if (!snapshot[name]) continue
      const used = object(snapshot[name])['usedPercent']
      if (typeof used !== 'number' || !Number.isFinite(used)) continue
      known = true
      if (used >= 100) {
        blocked = true
        const reset = object(snapshot[name])['resetsAt']
        if (typeof reset === 'number' && reset > 0 && reset < 8.64e12)
          blockingResets.push(new Date(reset * 1000).toISOString())
        else unknownReset = true
      }
    }
  }
  for (const [id, value] of snapshots) {
    const snapshot = object(value)
    for (const name of ['primary', 'secondary']) {
      if (!snapshot[name]) continue
      const window = object(snapshot[name])
      const used = window['usedPercent']
      if (typeof used !== 'number' || !Number.isFinite(used)) continue
      const reset = window['resetsAt']
      windows.push({
        limitId: `${identifier(id) ? id : 'codex'}:${name}`,
        remainingPercent: Math.max(0, Math.min(100, 100 - used)),
        resetsAt:
          typeof reset === 'number' && reset > 0 && reset < 8.64e12
            ? new Date(reset * 1000).toISOString()
            : null,
      })
    }
  }
  return {
    provider: 'codex-subscription',
    plan: identifier(current['planType']) ? current['planType'] : null,
    state: blocked ? 'limited' : known ? 'available' : 'unknown',
    resetsAt: blocked && !unknownReset ? (blockingResets.sort().at(-1) ?? null) : null,
    windows,
    lastError: null,
  }
}
