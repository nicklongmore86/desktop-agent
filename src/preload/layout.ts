import { layoutChannels, type LayoutApi } from '../shared/ipc-layout'
import type { Invoke } from './features'

export const layoutApi = (invoke: Invoke): LayoutApi => ({
  layout: {
    get: () => invoke(layoutChannels.layoutGet),
    set: (layout) => invoke(layoutChannels.layoutSet, layout),
  },
})
