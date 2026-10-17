/**
 * The per-feature preload APIs (see docs/ipc-modules.md). Add one import and one
 * spread below, in alphabetical order.
 */
import type { FeatureApis } from '../shared/ipc-features'
import type { PushChannel, PushPayloads } from '../shared/ipc'
import { commandApi } from './command'
import { connectionsApi } from './connections'
import { filesApi } from './files'
import { gitApi } from './git'
import { layoutApi } from './layout'
import { projectsApi } from './projects'

export type Invoke = <T>(channel: string, ...args: unknown[]) => Promise<T>

/** Subscribes to a main -> renderer push; returns the unsubscribe. */
export type Subscribe = <C extends PushChannel>(
  channel: C,
  listener: (payload: PushPayloads[C]) => void,
) => () => void

export const featureApis = (invoke: Invoke, subscribe: Subscribe): FeatureApis => ({
  ...commandApi(invoke),
  ...connectionsApi(invoke),
  ...filesApi(invoke, subscribe),
  ...gitApi(invoke, subscribe),
  ...layoutApi(invoke),
  ...projectsApi(invoke),
})
