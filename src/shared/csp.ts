export interface CspOptions {
  /** Dev mode relaxes script/connect rules so Vite's HMR client can run. */
  dev?: boolean
}

/**
 * Builds the renderer's Content-Security-Policy. Production allows only
 * resources bundled with the app: no remote scripts, styles, frames or objects.
 */
export function buildCsp({ dev = false }: CspOptions = {}): string {
  const directives: Record<string, string[]> = {
    'default-src': ["'none'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': ["'self'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'"],
    'connect-src': dev ? ["'self'", 'ws://localhost:*'] : ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
  }
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${sources.join(' ')}`)
    .join('; ')
}
