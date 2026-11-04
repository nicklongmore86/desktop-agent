/** The one rule for links the app hands to the user's browser: http(s) only. */
export function isWebLink(target: string): boolean {
  return /^https?:\/\//.test(target)
}
