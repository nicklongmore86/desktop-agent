import { connectionsChannels, type ConnectionsApi } from '../shared/ipc-connections'
import type { Invoke } from './features'

export const connectionsApi = (invoke: Invoke): ConnectionsApi => ({
  connections: {
    list: () => invoke(connectionsChannels.connectionsList),
  },
})
