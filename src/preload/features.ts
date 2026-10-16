/**
 * The per-feature preload APIs (see docs/ipc-modules.md). Add one import and one
 * spread below, in alphabetical order.
 */
import type { FeatureApis } from '../shared/ipc-features'
import { layoutApi } from './layout'

export type Invoke = <T>(channel: string, ...args: unknown[]) => Promise<T>

export const featureApis = (invoke: Invoke): FeatureApis => ({
  ...layoutApi(invoke),
})
