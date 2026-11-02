import type { SharingPrompt, SharingReason } from '../../shared/ipc'
import type { ConnectionId, Vendor } from '../../shared/ipc-connections'
import {
  attachmentsOf,
  type MessageOrigin,
  type SharingConfirmation,
  type StoredMessage,
} from '../storage/conversation-store'

/** What the sharing check needs to know about a registered connection. */
export interface SharingConnection {
  vendor: Vendor
  /** "Ollama · Local": shown in the prompt. */
  label: string
  /**
   * The connection is a Gemini API key, which may be a free-tier key (the app cannot
   * tell free from paid): what it is sent may be used by Google.
   */
  geminiKey?: boolean
  /** Shown with a 'gemini-free-tier' prompt: the connection's own data-use notice. */
  notice?: SharingPrompt['notice']
}

/** Looks up a connection; undefined for one this build does not register. */
export type DescribeConnection = (id: ConnectionId) => SharingConnection | undefined

/** What a sharing check needs: the open chat and where it would go. */
export interface SharingCheck {
  conversation: readonly StoredMessage[]
  origin: readonly MessageOrigin[]
  /** The chat's home connection: the writer of messages before the first `origin` entry. */
  home: ConnectionId
  target: ConnectionId
  sharing: readonly SharingConfirmation[]
  describe: DescribeConnection
  /** Files attached to the message being sent (checked already): they go too. Default 0. */
  attaching?: number
}

/** Why a send needs confirmation, before main gives it an id and a chat. */
export type SharingNeed = Omit<SharingPrompt, 'id' | 'chat'>

/** Consecutive messages written by one connection: [from, to). */
interface Segment {
  from: number
  to: number
  connection: ConnectionId
}

/**
 * Who wrote which messages: each `origin` entry's range, and the home connection for
 * the messages before the first one (a chat saved before provenance was kept, or a
 * chat's first prompt).
 */
function segments(length: number, origin: readonly MessageOrigin[], home: ConnectionId): Segment[] {
  const kept = origin.filter((entry) => entry.fromIndex < length)
  const first = kept[0]?.fromIndex ?? length
  const out: Segment[] = first > 0 ? [{ from: 0, to: first, connection: home }] : []
  kept.forEach((entry, index) => {
    out.push({
      from: entry.fromIndex,
      to: kept[index + 1]?.fromIndex ?? length,
      connection: entry.connection,
    })
  })
  return out
}

/**
 * Why content written by `source` needs confirmation before it goes to `target`, if it
 * does. Never for the same connection, the same vendor or a local target. A connection
 * this build does not know is treated as another vendor that is not local.
 */
function reasonsFor(
  source: SharingConnection | undefined,
  target: SharingConnection,
): SharingReason[] {
  if (target.vendor === 'local') return []
  if (source && source.vendor === target.vendor) return []
  return [
    ...(source?.vendor === 'local' ? (['local-to-cloud'] as const) : []),
    ...(target.geminiKey ? (['gemini-free-tier'] as const) : []),
  ]
}

/**
 * Whether sending the open chat to `target` needs the user's confirmation first, and
 * what to tell them: null when it does not. Only content not yet covered by a
 * confirmation for `target` counts. See docs/connections.md.
 */
export function sharingNeed(check: SharingCheck): SharingNeed | null {
  const { conversation, origin, home, target, sharing, describe, attaching = 0 } = check
  if (conversation.length === 0) return null
  const to = describe(target)
  if (!to) return null
  const covered = sharing.find((entry) => entry.connection === target)?.through ?? 0
  const reasons = new Set<SharingReason>()
  const sources = new Set<string>()
  for (const segment of segments(conversation.length, origin, home)) {
    if (segment.connection === target || segment.to <= covered) continue
    const from = describe(segment.connection)
    const found = reasonsFor(from, to)
    if (found.length === 0) continue
    for (const reason of found) reasons.add(reason)
    sources.add(from?.label ?? 'Another connection')
  }
  if (reasons.size === 0) return null
  const blocks = conversation.flatMap((message) =>
    typeof message.content === 'string' ? [] : message.content,
  )
  const ordered = (['local-to-cloud', 'gemini-free-tier'] as const).filter((r) => reasons.has(r))
  return {
    connection: target,
    destination: to.label,
    reasons: ordered,
    sources: [...sources],
    includes: {
      messages: conversation.length,
      toolOutput: blocks.some((block) => block.type === 'tool_result'),
      attachments:
        conversation.reduce((n, message) => n + attachmentsOf(message).length, 0) + attaching,
      attachmentsInMessage: attaching,
    },
    ...(to.geminiKey && to.notice ? { notice: to.notice } : {}),
  }
}

/** `sharing` with `target` confirmed for the first `through` messages. */
export function withSharing(
  sharing: readonly SharingConfirmation[],
  target: ConnectionId,
  through: number,
): SharingConfirmation[] {
  return [
    ...sharing.filter((entry) => entry.connection !== target).map((entry) => ({ ...entry })),
    { connection: target, through },
  ]
}

/** The refusal a send answers with until the user confirms (code 'confirmation_required'). */
export function sharingMessage(need: SharingNeed): string {
  return `Confirm before this chat is sent to ${need.destination}.`
}
