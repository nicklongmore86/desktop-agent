import { useCallback, useEffect, useState } from 'react'
import type { ModelOption, ProviderFailure } from '../../shared/ipc'
import type { ConnectionId, ConnectionInfo } from '../../shared/ipc-connections'
import { useApi } from './api'
import { connectionOf, useConnections } from './connections'

export interface ModelChoice {
  provider: ConnectionId
  options: ModelOption[]
  /** The saved choice that is still offered; null means the account default. */
  selected: string | null
  /** Shown when the model that will run is not the saved one. */
  note: string | null
  /** The connection's own default, which the wizard marks "Recommended". */
  recommended: string | null
  /** Shown with the list in Settings (local servers do not say which models use tools). */
  warning?: string
}

export interface ProviderModelPicker {
  /** Null while loading, or when the provider has no list to choose from. */
  choice: ModelChoice | null
  /** False until the first read has finished (with or without a list). */
  loaded: boolean
  /** The typed reason the last read or save failed; null when it did not, or gave none. */
  failure: ProviderFailure | null
  refresh: () => void
  /** Saves a model (null: the default). Returns false when it could not be saved. */
  select: (model: string | null) => Promise<boolean>
}

/** An API-key connection without its own list (Anthropic API) uses the Settings model API. */
const usesModelApi = (connection: ConnectionInfo | undefined): boolean =>
  connection?.capabilities.authKind === 'api-key' && !connection.capabilities.listsModels

/**
 * The model list for the composer: provider.models() for connections that list
 * models (Codex, the other API and local connections; Claude returns none, so no
 * picker) and the existing model API for Anthropic API mode.
 */
export function useProviderModels(provider: ConnectionId | undefined): ProviderModelPicker {
  const api = useApi()
  const connections = useConnections()
  const modelApi = usesModelApi(connectionOf(connections, provider))
  const [choice, setChoice] = useState<ModelChoice | null>(null)
  const [readFailure, setReadFailure] = useState<ProviderFailure | null>(null)
  const [saveFailure, setSaveFailure] = useState<ProviderFailure | null>(null)
  const [tick, setTick] = useState(0)
  const [loadedFor, setLoadedFor] = useState<ConnectionId | null>(null)

  useEffect(() => {
    if (!provider || !connections) return
    let current = true
    const read = async (): Promise<void> => {
      let next: ModelChoice | null = null
      let failed: ProviderFailure | null = null
      try {
        if (modelApi) {
          const model = await api.model.get()
          if (model.options.length > 0)
            next = {
              provider,
              options: model.options,
              selected: model.model,
              note: null,
              recommended: model.defaultModel,
            }
        } else {
          const result = await api.provider.models()
          if (result.ok && result.value.provider === provider && result.value.options.length > 0) {
            const { options, savedModel, resolvedModel, defaultModel, warning } = result.value
            const offered = options.some((option) => option.id === savedModel)
            next = {
              provider,
              options,
              selected: offered ? savedModel : null,
              note:
                savedModel && resolvedModel && resolvedModel !== savedModel
                  ? 'Using default model'
                  : null,
              recommended: defaultModel,
              ...(warning ? { warning } : {}),
            }
          } else if (!result.ok) {
            failed = result.failure
          }
        }
      } catch {
        // No picker when the list cannot be read.
      }
      if (current) {
        setChoice(next)
        setReadFailure(failed)
        setLoadedFor(provider)
      }
    }
    void read()
    return () => {
      current = false
    }
  }, [api, provider, connections, modelApi, tick])

  const refresh = useCallback(() => {
    setSaveFailure(null)
    setTick((value) => value + 1)
  }, [])

  const select = useCallback(
    async (model: string | null): Promise<boolean> => {
      setSaveFailure(null)
      try {
        if (modelApi) {
          if (model === null) return false
          await api.model.set(model)
        } else {
          const result = await api.provider.setModel(model)
          if (!result.ok) {
            setSaveFailure(result.failure)
            return false
          }
        }
      } catch {
        return false
      } finally {
        setTick((value) => value + 1)
      }
      return true
    },
    [api, modelApi],
  )

  return {
    choice: choice && choice.provider === provider ? choice : null,
    loaded: provider !== undefined && loadedFor === provider,
    failure: saveFailure ?? readFailure,
    refresh,
    select,
  }
}
