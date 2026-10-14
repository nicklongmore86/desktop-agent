// The built-in blocklist: locations the agent may never touch, even inside a
// granted folder. It is not configurable. Matching is on whole path segments
// and always case-insensitive, so `.SSH` and `ID_RSA` are blocked on every OS.

/** Folder names that hold credentials. Anything named like this, or inside it, is blocked. */
const BLOCKED_NAMES = new Map<string, string>([
  ['.ssh', 'SSH keys'],
  ['.claude', 'Claude credentials and settings'],
  ['.claude.json', 'Claude account settings'],
  ['.codex', 'Codex credentials and settings'],
  ['.gnupg', 'GnuPG keys'],
  ['.aws', 'AWS credentials'],
  ['.azure', 'Azure credentials'],
  ['.kube', 'Kubernetes credentials'],
  ['.npmrc', 'npm credentials'],
  ['.netrc', 'netrc credentials'],
  ['_netrc', 'netrc credentials'],
  ['.git-credentials', 'Git credentials'],
])

/** File extensions of keys, certificates and password databases. */
const BLOCKED_EXTENSIONS = new Map<string, string>([
  ['.pem', 'private keys and certificates'],
  ['.key', 'private keys'],
  ['.pfx', 'certificate stores'],
  ['.p12', 'certificate stores'],
  ['.kdbx', 'KeePass databases'],
])

/**
 * Runs of consecutive segments. A path is blocked when the run appears anywhere
 * in it, which covers the location itself and everything below it.
 */
const BLOCKED_SEQUENCES: readonly { segments: readonly string[]; reason: string }[] = [
  { segments: ['.docker', 'config.json'], reason: 'Docker credentials' },
  // Browser profiles (cookies, saved passwords, session tokens).
  { segments: ['google', 'chrome', 'user data'], reason: 'Chrome profiles' },
  { segments: ['google', 'chrome beta', 'user data'], reason: 'Chrome profiles' },
  { segments: ['chromium', 'user data'], reason: 'Chromium profiles' },
  { segments: ['microsoft', 'edge', 'user data'], reason: 'Edge profiles' },
  { segments: ['bravesoftware', 'brave-browser', 'user data'], reason: 'Brave profiles' },
  { segments: ['mozilla', 'firefox', 'profiles'], reason: 'Firefox profiles' },
  { segments: ['.mozilla', 'firefox'], reason: 'Firefox profiles' },
  { segments: ['.config', 'google-chrome'], reason: 'Chrome profiles' },
  { segments: ['.config', 'chromium'], reason: 'Chromium profiles' },
  { segments: ['.config', 'microsoft-edge'], reason: 'Edge profiles' },
  { segments: ['.config', 'bravesoftware'], reason: 'Brave profiles' },
  { segments: ['application support', 'google', 'chrome'], reason: 'Chrome profiles' },
  { segments: ['application support', 'microsoft edge'], reason: 'Edge profiles' },
  { segments: ['application support', 'firefox', 'profiles'], reason: 'Firefox profiles' },
  // Windows Credential Manager and DPAPI master keys.
  { segments: ['appdata', 'roaming', 'microsoft', 'credentials'], reason: 'Windows credentials' },
  { segments: ['appdata', 'local', 'microsoft', 'credentials'], reason: 'Windows credentials' },
  { segments: ['appdata', 'roaming', 'microsoft', 'protect'], reason: 'Windows DPAPI keys' },
  { segments: ['appdata', 'roaming', 'microsoft', 'crypto'], reason: 'Windows crypto keys' },
  { segments: ['appdata', 'local', 'microsoft', 'vault'], reason: 'Windows Vault' },
  { segments: ['appdata', 'roaming', 'microsoft', 'vault'], reason: 'Windows Vault' },
]

function nameReason(name: string): string | null {
  const named = BLOCKED_NAMES.get(name)
  if (named) return named
  if (name === '.env' || name.startsWith('.env.')) return 'environment files (.env, .env.*)'
  if (/^id_(rsa|dsa|ecdsa|ed25519)/.test(name)) return 'SSH private keys'
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? (BLOCKED_EXTENSIONS.get(name.slice(dot)) ?? null) : null
}

function containsRun(segments: readonly string[], run: readonly string[]): boolean {
  outer: for (let i = 0; i + run.length <= segments.length; i++) {
    for (let j = 0; j < run.length; j++) {
      if (segments[i + j] !== run[j]) continue outer
    }
    return true
  }
  return false
}

/** Splits an absolute path into lower-cased name segments (drive or root dropped). */
export function pathSegments(p: string, platform: NodeJS.Platform): string[] {
  const separators = platform === 'win32' ? /[\\/]+/ : /\/+/
  const parts = p.toLowerCase().split(separators)
  if (platform === 'win32' && /^[a-z]:$/.test(parts[0] ?? '')) parts.shift()
  return parts.filter((s) => s !== '' && s !== '.')
}

/**
 * Why the built-in blocklist forbids `p`, or null when it does not. `p` is an
 * absolute path; the check covers every segment, so blocked folders also block
 * everything inside them.
 */
export function blocklistReason(p: string, platform: NodeJS.Platform): string | null {
  const segments = pathSegments(p, platform)
  for (const segment of segments) {
    const reason = nameReason(segment)
    if (reason) return `"${segment}" is blocked (${reason}).`
  }
  for (const { segments: run, reason } of BLOCKED_SEQUENCES) {
    if (containsRun(segments, run)) return `"${run.join('/')}" is blocked (${reason}).`
  }
  return null
}
