import { shell } from 'electron'
import { webLinkHref } from './web-link-rule'

/** Opens an http(s) link in the user's browser (in its parsed form); every other scheme is ignored. */
export function openWebLink(target: string): void {
  const href = webLinkHref(target)
  if (href !== null) void shell.openExternal(href)
}
