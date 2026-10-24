import {
  ATTACHMENT_PASTE_MAX_BYTES,
  attachmentsChannels,
  type AttachmentsApi,
} from '../shared/ipc-attachments'
import type { Invoke } from './features'

export const attachmentsApi = (invoke: Invoke): AttachmentsApi => ({
  attachments: {
    pick: () => invoke(attachmentsChannels.attachmentsPick),
    // Refused here before the bytes are copied across; main checks the size again.
    fromPaste: (bytes, mime, name) =>
      bytes.byteLength > ATTACHMENT_PASTE_MAX_BYTES
        ? Promise.resolve({
            ok: false,
            code: 'too-large',
            reason: 'That paste is too big to attach.',
          })
        : invoke(attachmentsChannels.attachmentsFromPaste, bytes, mime, name),
    copyIntoFolder: (id, folder) =>
      invoke(attachmentsChannels.attachmentsCopyIntoFolder, id, folder),
  },
})
