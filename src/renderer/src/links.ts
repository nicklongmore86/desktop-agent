// Web links in a reply. The reply is untrusted (the agent reads untrusted documents), so a link
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
