import { connectionsChannels, type ConnectionsApi } from '../shared/ipc-connections'
import type { Invoke } from './features'

export const connectionsApi = (invoke: Invoke): ConnectionsApi => ({
  connections: {
    list: () => invoke(connectionsChannels.connectionsList),
    state: () => invoke(connectionsChannels.connectionsState),
    status: (id) => invoke(connectionsChannels.connectionsStatus, id),
    add: (id) => invoke(connectionsChannels.connectionsAdd, id),
    remove: (id) => invoke(connectionsChannels.connectionsRemove, id),
    setShowPersonalUse: (show) => invoke(connectionsChannels.connectionsSetShowPersonalUse, show),
  },
})
