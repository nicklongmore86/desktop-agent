/**
 * The per-feature preload APIs (see docs/ipc-modules.md). Add one import and one
 * spread below, in alphabetical order.
 */
import type { FeatureApis } from '../shared/ipc-features'
import type { PushChannel, PushPayloads } from '../shared/ipc'
import { filesApi } from './files'
import { layoutApi } from './layout'

export type Invoke = <T>(channel: string, ...args: unknown[]) => Promise<T>

/** Subscribes to a main -> renderer push; returns the unsubscribe. */
export type Subscribe = <C extends PushChannel>(
  channel: C,
  listener: (payload: PushPayloads[C]) => void,
) => () => void

export const featureApis = (invoke: Invoke, subscribe: Subscribe): FeatureApis => ({
  ...filesApi(invoke, subscribe),
  ...layoutApi(invoke),
})
