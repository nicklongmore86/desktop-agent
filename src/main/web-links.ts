import { shell } from 'electron'
import { isWebLink } from './web-link-rule'

/** Opens an http(s) link in the user's browser; every other scheme is ignored. */
export function openWebLink(target: string): void {
  if (isWebLink(target)) void shell.openExternal(target)
}
