import { useCallback, useEffect, useRef, useState } from 'react'
import { useApi } from '../api'
import type { OpenSettings } from '../open-settings'
import { useToast } from '../components/Toast'
import type { AttachOutcome } from '../../../shared/ipc-attachments'
import {
  admit,
  refusalMessage,
  sortOutcomes,
  summarizeRefusals,
  type StagedAttachment,
} from './model'
import { readThumbnail, rememberThumbnail } from './thumbnails'

/** Said when attaching is paused. */
export const PAUSED_NOTE = 'Wait for the reply to finish before attaching files.'

/** Keeps a preview of a dropped or pasted image, so its chip (and the sent message's) can show it. */
async function remember(outcome: AttachOutcome, source: Blob): Promise<AttachOutcome> {
  if (outcome.ok && outcome.kind === 'attachment' && outcome.attachment.kind === 'image') {
    const url = await readThumbnail(source)
    if (url) rememberThumbnail(outcome.attachment.id, url)
  }
  return outcome
}

export interface AttachmentsControl {
  staged: StagedAttachment[]
  ids: string[]
  /** Attaching is paused (a reply is running or the chat is switching). */
  disabled: boolean
  attachFiles: (files: readonly File[]) => Promise<void>
  pick: () => Promise<void>
  /** Handles a paste event's files; true when it took them (the caller then stops the default). */
  paste: (data: DataTransfer | null) => boolean
  remove: (id: string) => void
  clear: () => void
  copyIntoFolder: (id: string) => void
}

interface Deps {
  /** Puts `@"path"` text into the message box. */
  insertText: (text: string) => void
  onOpenSettings: OpenSettings
  disabled: boolean
}

/**
 * The composer's attachments: what is staged, and how files from a drop, the picker or a
 * paste become chips, `@` references or a toast. Main checks every file; this only sorts
 * its answers and enforces the per-message limits before send.
 */
export function useAttachments({ insertText, onOpenSettings, disabled }: Deps): AttachmentsControl {
  const api = useApi()
  const notify = useToast()
  const [staged, setStaged] = useState<StagedAttachment[]>([])
  // Latest list for code that runs after an await (a drop's several files land one by one).
  const stagedRef = useRef(staged)
  useEffect(() => {
    stagedRef.current = staged
  })
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const apply = useCallback(
    (outcomes: readonly AttachOutcome[], names: readonly (string | undefined)[] = []) => {
      const sorted = sortOutcomes(outcomes, names)
      const admission = admit(stagedRef.current, sorted.attachments)
      stagedRef.current = admission.staged
      setStaged(admission.staged)
      if (sorted.references.length > 0) insertText(sorted.references.join(' '))
      const messages = [...sorted.refusals.map((r) => r.message), ...admission.refusals]
      const message = summarizeRefusals(messages)
      if (!message) return
      const grantFolder = sorted.refusals.some((r) => r.code === 'grant-folder')
      notify(
        message,
        grantFolder
          ? {
              label: 'Open Settings',
              onClick: () => {
                onOpenSettings('folders')
              },
            }
          : undefined,
      )
    },
    [insertText, notify, onOpenSettings],
  )

  const attachFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (files.length === 0) return
      if (disabled) {
        notify(PAUSED_NOTE)
        return
      }
      const settled = await Promise.all(
        files.map(async (file): Promise<AttachOutcome> => {
          try {
            return await remember(await api.files.attachDropped(file), file)
          } catch {
            return { ok: false, code: 'failed', reason: '' }
          }
        }),
      )
      if (mounted.current)
        apply(
          settled,
          files.map((file) => file.name),
        )
    },
    [api, apply, disabled, notify],
  )

  const pick = useCallback(async (): Promise<void> => {
    if (disabled) {
      notify(PAUSED_NOTE)
      return
    }
    try {
      const outcomes = await api.attachments.pick()
      if (mounted.current) apply(outcomes)
    } catch {
      notify(refusalMessage('failed', ''))
    }
  }, [api, apply, disabled, notify])

  const paste = useCallback(
    (data: DataTransfer | null): boolean => {
      const files = Array.from(data?.files ?? [])
      if (files.length === 0) return false
      if (disabled) {
        notify(PAUSED_NOTE)
        return true
      }
      // A file copied in the OS has a path (attachDropped); a screenshot or copied image does not.
      void (async () => {
        const outcomes = await Promise.all(
          files.map(async (file): Promise<AttachOutcome> => {
            try {
              const outcome = await api.files.attachDropped(file)
              if (outcome.ok || outcome.code !== 'invalid') return await remember(outcome, file)
              const bytes = new Uint8Array(await file.arrayBuffer())
              const pasted = await api.attachments.fromPaste(
                bytes,
                file.type,
                file.name || undefined,
              )
              return await remember(pasted, file)
            } catch {
              return { ok: false, code: 'failed', reason: '' }
            }
          }),
        )
        if (mounted.current)
          apply(
            outcomes,
            files.map((file) => file.name || undefined),
          )
      })()
      return true
    },
    [api, apply, disabled, notify],
  )

  const remove = useCallback((id: string) => {
    setStaged((current) => current.filter((item) => item.attachment.id !== id))
  }, [])
  const clear = useCallback(() => {
    stagedRef.current = []
    setStaged([])
  }, [])

  const copyIntoFolder = useCallback(
    (id: string) => {
      void (async () => {
        try {
          const [first] = await api.files.roots()
          if (!first) {
            notify(refusalMessage('grant-folder', ''), {
              label: 'Open Settings',
              onClick: () => {
                onOpenSettings('folders')
              },
            })
            return
          }
          const result = await api.attachments.copyIntoFolder(id, { rootId: first.id, rel: '' })
          if (result.ok) {
            insertText(result.text)
            setStaged((current) => current.filter((item) => item.attachment.id !== id))
          } else if (!result.declined) notify(result.reason)
        } catch {
          notify('Could not copy the file into the folder.')
        }
      })()
    },
    [api, insertText, notify, onOpenSettings],
  )

  return {
    staged,
    ids: staged.map((item) => item.attachment.id),
    disabled,
    attachFiles,
    pick,
    paste,
    remove,
    clear,
    copyIntoFolder,
  }
}
