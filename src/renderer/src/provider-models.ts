import { useCallback, useEffect, useState } from 'react'
import type { ModelOption, ProviderFailure, ProviderId } from '../../shared/ipc'
import { useApi } from './api'

export interface ModelChoice {
  provider: ProviderId
  options: ModelOption[]
  /** The saved choice that is still offered; null means the account default. */
  selected: string | null
  /** Shown when the model that will run is not the saved one. */
  note: string | null
}

export interface ProviderModelPicker {
  /** Null while loading, or when the provider has no list to choose from. */
  choice: ModelChoice | null
  /** The typed reason the last read or save failed; null when it did not, or gave none. */
  failure: ProviderFailure | null
  refresh: () => void
  /** Saves a model (null: the default). Returns false when it could not be saved. */
  select: (model: string | null) => Promise<boolean>
}

/**
 * The model list for the composer: provider.models() for the subscriptions
 * (Codex lists models; Claude returns none, so no picker) and the existing
 * model API for Anthropic API mode.
 */
export function useProviderModels(provider: ProviderId | undefined): ProviderModelPicker {
  const api = useApi()
  const [choice, setChoice] = useState<ModelChoice | null>(null)
  const [readFailure, setReadFailure] = useState<ProviderFailure | null>(null)
  const [saveFailure, setSaveFailure] = useState<ProviderFailure | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (!provider) return
    let current = true
    const read = async (): Promise<void> => {
      let next: ModelChoice | null = null
      let failed: ProviderFailure | null = null
      try {
        if (provider === 'anthropic-api') {
          const model = await api.model.get()
          if (model.options.length > 0)
            next = { provider, options: model.options, selected: model.model, note: null }
        } else {
          const result = await api.provider.models()
          if (result.ok && result.value.provider === provider && result.value.options.length > 0) {
            const { options, savedModel, resolvedModel } = result.value
            const offered = options.some((option) => option.id === savedModel)
            next = {
              provider,
              options,
              selected: offered ? savedModel : null,
              note:
                savedModel && resolvedModel && resolvedModel !== savedModel
                  ? 'Using default model'
                  : null,
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
      }
    }
    void read()
    return () => {
      current = false
    }
  }, [api, provider, tick])

  const refresh = useCallback(() => {
    setSaveFailure(null)
    setTick((value) => value + 1)
  }, [])

  const select = useCallback(
    async (model: string | null): Promise<boolean> => {
      setSaveFailure(null)
      try {
        if (provider === 'anthropic-api') {
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
    [api, provider],
  )

  return {
    choice: choice && choice.provider === provider ? choice : null,
    failure: saveFailure ?? readFailure,
    refresh,
    select,
  }
}
