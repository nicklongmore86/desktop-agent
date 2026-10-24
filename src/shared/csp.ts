export interface CspOptions {
  /** Dev mode relaxes script/style/connect rules so Vite's dev server and HMR can run. */
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
    // Vite injects imported CSS as inline <style> tags in dev; the build emits files.
    'style-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    // `blob:` is for previews of images the user dropped or pasted (object URLs of their File).
    'img-src': ["'self'", 'data:', 'blob:'],
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
