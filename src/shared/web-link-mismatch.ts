// The one rule for a web link whose visible text claims a different site. Pure and shared: the
// click in the page (ReplyLinks.tsx) and the native right-click menu in the main process both
// ask it, so there is one rule, not two. The reply is untrusted (the agent reads untrusted documents), so a link
// can say one thing and go to another: `[example.com](https://evil.test)`. This works out where a
// link really goes and whether its visible text pretends to be somewhere else. It only advises
// the click; the main process still opens nothing but http(s) (see main/window.ts).

/** A web link's real destination: what the browser would connect to. */
export interface WebDestination {
  /** The host as the browser reads it: lower case, punycode for non-ASCII names. */
  host: string
}

/** The destination of an http(s) link, or null for anything else (mailto:, a path, a fragment). */
export function webDestination(href: string): WebDestination | null {
  if (!/^https?:/i.test(href)) return null
  try {
    const url = new URL(href)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return { host: url.hostname.toLowerCase() }
  } catch {
    return null
  }
}

// Top-level domains common enough that `name.tld` in link text reads as a web address. File
// extensions that are also TLDs (md, sh, py, pl, rs, ts, zip, mov) are left out, so a link
// labelled `README.md` does not ask.
const COMMON_TLDS = new Set(
  (
    'com net org edu gov mil int info biz io dev app ai co me tv cc xyz online site tech cloud ' +
    'shop store blog page link live news pro name uk us de fr nl eu es it se no dk fi ch at be ' +
    'ie pt ru cn jp kr in au nz ca br mx ar za'
  ).split(' '),
)

const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** The host a piece of link text claims, or null when it does not read as a web address. */
function claimedHost(token: string): string | null {
  const hasScheme = SCHEME.test(token)
  const candidate = hasScheme ? token : `https://${token}`
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'ftp:') return null
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') && !hasScheme) return null
  if (host.startsWith('[')) return host
  const labels = host.split('.')
  const tld = labels.at(-1) ?? ''
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
  const looksWeb =
    hasScheme || /^www\./i.test(token) || ipv4 || tld.startsWith('xn--') || COMMON_TLDS.has(tld)
  if (!looksWeb) return null
  // Bare text only counts as an address when it is one: no spaces, a real dotted host.
  if (!hasScheme && !ipv4 && labels.some((label) => label === '')) return null
  return host
}

const withoutWww = (host: string): string => host.replace(/^www\./, '')

/** Link text with its formatting and spacing flattened, split into candidate words. */
function words(text: string): string[] {
  return text
    .split(/\s+/)
    .map((word) => word.replace(/^[([{<"'“‘]+/, '').replace(/[)\]}>"'”’.,;:!?]+$/, ''))
    .filter((word) => word !== '')
}

/**
 * The host the visible link text claims when it is not the link's real host, else null. A link
 * whose text reads as a web address (`https://example.com`, `www.example.com`, `example.com/x`)
 * but goes to another host is the case worth asking about. Text that is not an address, or
 * that names the same host (a leading `www.` aside), is fine.
 */
export function misleadingHost(text: string, realHost: string): string | null {
  for (const word of words(text)) {
    const claimed = claimedHost(word)
    if (claimed !== null && withoutWww(claimed) !== withoutWww(realHost)) return claimed
  }
  return null
}

/**
 * A link target for showing: the parser percent-encodes non-ASCII characters (`%D0%B0`), which
 * would hide a look-alike letter or a direction override from the display helpers, so those
 * sequences (and only those: `%2F` and the like stay as they are) are turned back into the
 * characters. The result is for display only; the real link is never changed.
 */
export function displayUrl(href: string): string {
  return href.replace(/(?:%[CcDdEeFf][0-9A-Fa-f](?:%[89ABab][0-9A-Fa-f]){1,3})/g, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** A link whose visible text names another site than the one it goes to. */
export interface LinkMismatch {
  /** The host the visible text claims (as the browser would read it). */
  claimed: string
  /** The host the link really goes to. */
  host: string
}

/**
 * Whether `text` (what the link shows) claims a different site than `href` (where it goes).
 * Null when `href` is not an http(s) link, or the text does not read as another address.
 */
export function linkMismatch(text: string, href: string): LinkMismatch | null {
  const destination = webDestination(href)
  if (destination === null) return null
  const claimed = misleadingHost(text, destination.host)
  return claimed === null ? null : { claimed, host: destination.host }
}

/**
 * A link target for a native (plain text) dialog, which has no way to mark hidden characters.
 * The parsed form is ASCII (the host as punycode, other characters percent-encoded), and any
 * character that is not printable ASCII is still replaced by a visible `⟨U+XXXX⟩` token, so
 * nothing hidden or direction-changing can reach the dialog. Long targets are shortened.
 */
export function plainDestination(href: string, limit = 400): string {
  let shown: string
  try {
    shown = new URL(href).href
  } catch {
    shown = href
  }
  let out = ''
  for (const ch of shown) {
    const code = ch.codePointAt(0) ?? 0
    out +=
      code >= 0x20 && code <= 0x7e ? ch : `⟨U+${code.toString(16).toUpperCase().padStart(4, '0')}⟩`
  }
  return out.length > limit ? `${out.slice(0, limit)}…` : out
}
