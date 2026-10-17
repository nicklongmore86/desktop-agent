import type { ConnectionInfo } from '../../../../shared/ipc-connections'

/** A warning the connection wants shown where the user sets it up (a free key's data use). */
export const noticeOf = (info: ConnectionInfo): string | undefined =>
  (info as ConnectionInfo & { notice?: string }).notice
