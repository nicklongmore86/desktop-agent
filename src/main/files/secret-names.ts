// Files the Workspace panels keep closed: their names show with a lock, and the
// panels never preview, open, reference or drag them. This is display policy
// only. It is NOT the agent's blocklist (permissions/blocklist.ts), which
// decides what the agent may read and is unchanged by this list.

const SECRET_NAMES = new Set([
  '.envrc',
  '.htpasswd',
  '.pgpass',
  '.my.cnf',
  '.pypirc',
  'credentials',
  'secrets',
])

const SECRET_EXTENSIONS = new Set([
  '.env',
  '.tfvars',
  '.tfstate',
  '.keystore',
  '.jks',
  '.ppk',
  '.p8',
])

/** `secrets.json`, `credentials.yaml`, `service-account-prod.json`, `app.secret.toml`, ... */
const SECRET_STEMS = /^(secrets?|credentials?|service[-_]account.*|.*[-_.](secrets?|credentials?))$/

/**
 * True when a file name looks like it holds secrets. Matching ignores case,
 * like the blocklist, so `.ENV` and `Secrets.JSON` are caught on every OS.
 */
export function isSecretName(name: string): boolean {
  const lower = name.toLowerCase()
  if (lower === '.env' || lower.startsWith('.env.')) return true
  if (SECRET_NAMES.has(lower)) return true
  const dot = lower.lastIndexOf('.')
  if (dot > 0) {
    if (SECRET_EXTENSIONS.has(lower.slice(dot))) return true
    // `prod.tfvars.json`, `.env.local.bak` style double extensions.
    if (lower.includes('.tfvars.') || lower.includes('.tfstate.')) return true
    return SECRET_STEMS.test(lower.slice(0, dot))
  }
  return SECRET_STEMS.test(lower)
}
