import { ocrIndexChannels, ocrIndexPushChannels, type OcrIndexApi } from '../shared/ipc-ocr-index'
import type { Invoke, Subscribe } from './features'

export const ocrIndexApi = (invoke: Invoke, subscribe: Subscribe): OcrIndexApi => ({
  ocrIndex: {
    list: () => invoke(ocrIndexChannels.ocrIndexList),
    start: (location) => invoke(ocrIndexChannels.ocrIndexStart, location),
    pause: (id) => invoke(ocrIndexChannels.ocrIndexPause, id),
    resume: (id) => invoke(ocrIndexChannels.ocrIndexResume, id),
    cancel: (id) => invoke(ocrIndexChannels.ocrIndexCancel, id),
    dismiss: (id) => invoke(ocrIndexChannels.ocrIndexDismiss, id),
    onChanged: (listener) => subscribe(ocrIndexPushChannels.ocrIndexChanged, listener),
  },
})
