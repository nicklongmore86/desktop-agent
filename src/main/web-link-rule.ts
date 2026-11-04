/**
 * The one rule for links the app hands to the user's browser: http(s) only. The scheme is
 * compared after parsing, so `HTTPS://example.com` is accepted like `https://example.com`;
 * anything else (other schemes, text with spaces or control characters around it, a scheme
 * without `//`, text that does not parse) is refused.
 */
export function webLinkHref(target: string): string | null {
  if (!/^https?:\/\//i.test(target)) return null
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001F\u007F-\u009F]/.test(target)) return null
  try {
    const url = new URL(target)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

export function isWebLink(target: string): boolean {
  return webLinkHref(target) !== null
}
