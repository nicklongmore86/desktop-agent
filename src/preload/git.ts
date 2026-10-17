import { gitChannels, gitPushChannels, type GitApi } from '../shared/ipc-git'
import type { Invoke, Subscribe } from './features'

export const gitApi = (invoke: Invoke, subscribe: Subscribe): GitApi => ({
  git: {
    overview: () => invoke(gitChannels.gitOverview),
    status: (repo) => invoke(gitChannels.gitStatus, repo),
    diff: (request) => invoke(gitChannels.gitDiff, request),
    log: (request) => invoke(gitChannels.gitLog, request),
    watch: (repos) => invoke(gitChannels.gitWatch, repos),
    openInstallPage: () => invoke(gitChannels.gitOpenInstallPage),
    onChanged: (listener) => subscribe(gitPushChannels.gitChanged, listener),
  },
})
