import type { ConnectionId } from '../../shared/ipc-connections'

/** Which connection (and model, when known) wrote a reply. */
export interface ReplyOrigin {
  connection: ConnectionId
  model?: string | undefined
}

/**
 * The replies that get a provider badge: the first reply with a known origin, and each one
 * whose connection or model differs from the previous known one. A reply with no known
 * origin (saved before it was recorded) gets none and does not move the comparison. A
 * missing model never counts as a change: only two known, different models do.
 */
export function badgedReplies<T extends { id: string }>(
  replies: readonly T[],
  originOf: (reply: T) => ReplyOrigin | undefined,
): Map<string, ReplyOrigin> {
  const badges = new Map<string, ReplyOrigin>()
  let previous: ReplyOrigin | undefined
  for (const reply of replies) {
    const origin = originOf(reply)
    if (!origin) continue
    const changed =
      !previous ||
      origin.connection !== previous.connection ||
      (origin.model !== undefined &&
        previous.model !== undefined &&
        origin.model !== previous.model)
    if (changed) badges.set(reply.id, origin)
    previous = {
      connection: origin.connection,
      model:
        origin.model ?? (previous?.connection === origin.connection ? previous.model : undefined),
    }
  }
  return badges
}
