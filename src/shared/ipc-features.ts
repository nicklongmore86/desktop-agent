/**
 * The per-feature IPC modules, in one place. Each feature owns its own files
 * (shared/ipc-<feature>.ts, main/ipc-<feature>.ts, preload/<feature>.ts) and adds
 * ONE line to each of this file, main/ipc-features.ts and preload/features.ts, in
 * alphabetical order. See docs/ipc-modules.md.
 */
import { filesChannels, type FilesApi } from './ipc-files'
import { layoutChannels, type LayoutApi } from './ipc-layout'
import { projectsChannels, type ProjectsApi } from './ipc-projects'

/** What each feature adds to window.desktopApi. */
export type FeatureApis = FilesApi & LayoutApi & ProjectsApi

/** Every renderer -> main channel the feature modules register (the handler test enumerates it). */
export const FEATURE_CHANNELS: readonly string[] = [
  ...Object.values(filesChannels),
  ...Object.values(layoutChannels),
  ...Object.values(projectsChannels),
]
