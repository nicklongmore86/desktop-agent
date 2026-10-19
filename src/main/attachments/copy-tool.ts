// "Copy into folder…" for a file attached from outside the granted folders. It is
// a tool spec run through defineTool, like the agent's write_file: the destination
// goes through PathGuard, the user approves the copy in the usual approval dialog,
// and the call is audited. It is never offered to the agent: main builds its input
// from an attachment it issued, and the renderer only names the attachment's id.
import { ToolFailure, errorResult, type ToolSpec } from '../tools/define'
import { openVerified, overwriteHandle, sameIdentity, type Identity } from '../tools/safe-fs'
import { formatBytes } from '../tools/text'
import type { PathGuard } from '../permissions/guard'
import { attachmentId } from './store'
import { checkSource, openChecked, readUpTo } from './validate'

/** Where an outside-grant attachment came from, kept in main only. */
export interface AttachmentSourceRecord {
  name: string
  path: string
  identity: Identity
  size: number
  /** sha256 of the file's bytes when it was attached. */
  sha256: string
}

interface Input {
  id: string
  destination: string
}

export const COPY_TOOL = 'copy_into_folder'

export function copyIntoFolderTool(deps: {
  guard: PathGuard
  source: (id: string) => AttachmentSourceRecord | undefined
}): ToolSpec<Input> {
  const { guard } = deps
  return {
    name: COPY_TOOL,
    description: 'Copies a file the user attached from outside the granted folders into one.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, destination: { type: 'string' } },
      required: ['id', 'destination'],
      additionalProperties: false,
    },
    needsApproval: true,
    parse: (input) => ({ id: input.string('id'), destination: input.string('destination') }),
    summarize: (input) => ({ destination: input.destination, ...sizeOf(deps.source(input.id)) }),
    async run(input, call) {
      const source = deps.source(input.id)
      if (!source) throw new ToolFailure('That attachment is no longer available.', 'not-found')
      const { path: file, exists } = await call.resolve(input.destination)
      if (exists) throw new ToolFailure(`${file} already exists; nothing was copied.`, 'exists')

      // The copy is exactly what was attached: same file, same content.
      call.notePath(source.path)
      const checked = await checkSource(guard, source.path)
      if (!checked.ok) throw new ToolFailure(checked.reason, 'access-denied')
      if (checked.type !== 'file' || !sameIdentity(checked.identity, source.identity))
        throw changedSinceAttached(source.name)
      const handle = await openChecked(checked.path, source.identity)
      if ('ok' in handle) throw new ToolFailure(handle.reason, 'changed')
      let bytes: Buffer
      try {
        const read = await readUpTo(handle, source.size)
        if (!read.whole || attachmentId(read.bytes) !== source.sha256)
          throw changedSinceAttached(source.name)
        bytes = read.bytes
      } finally {
        await handle.close()
      }

      const approved = await call.approve({
        kind: 'write',
        summary: `Copy ${source.name} (${formatBytes(bytes.length)}) into ${guard.path.dirname(file)}`,
        detail: `From: ${source.path}\nTo: ${file}\n\nThe file is copied as it is; the original is not changed.`,
      })
      if (!approved)
        return errorResult(
          `The user declined copying ${source.name}. Nothing was copied.`,
          'declined',
        )

      const again = await call.resolve(input.destination)
      if (again.path !== file || again.exists)
        throw new ToolFailure(
          `${file} changed after the copy was approved; nothing was copied.`,
          'changed',
        )
      // Exclusive create: fails if anything (file or link) appeared at the path meanwhile.
      const opened = await openVerified(guard, file, 'create')
      try {
        await overwriteHandle(opened.handle, bytes)
      } finally {
        await opened.handle.close()
      }
      return { content: `Copied ${source.name} to ${file} (${formatBytes(bytes.length)}).` }
    },
  }
}

const sizeOf = (source: AttachmentSourceRecord | undefined) =>
  source ? { source: source.path, bytes: source.size } : { unknownAttachment: true }

function changedSinceAttached(name: string): ToolFailure {
  return new ToolFailure(
    `${name} changed after it was attached; nothing was copied. Attach it again.`,
    'changed',
  )
}
