import { describe, expect, it } from 'vitest'
import { buildCsp } from './csp'

function parse(csp: string): Map<string, string[]> {
  return new Map(
    csp.split('; ').map((directive) => {
      const [name = '', ...sources] = directive.split(' ')
      return [name, sources]
    }),
  )
}

describe('buildCsp', () => {
  it('only allows the app itself to provide scripts in production', () => {
    const csp = parse(buildCsp())
    expect(csp.get('default-src')).toEqual(["'none'"])
    expect(csp.get('script-src')).toEqual(["'self'"])
    expect(csp.get('style-src')).toEqual(["'self'"])
    expect(csp.get('connect-src')).toEqual(["'self'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(csp.get('base-uri')).toEqual(["'none'"])
  })

  it('never allows remote origins, eval or wildcards in production', () => {
    const csp = buildCsp()
    expect(csp).not.toMatch(/https?:/)
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).not.toContain('unsafe-inline')
    expect(csp).not.toMatch(/\s\*(;|$|\s)/)
  })

  it('relaxes only what the Vite dev server needs in dev mode', () => {
    const csp = parse(buildCsp({ dev: true }))
    expect(csp.get('script-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(csp.get('style-src')).toEqual(["'self'", "'unsafe-inline'"])
    expect(csp.get('connect-src')).toEqual(["'self'", 'ws://localhost:*'])
    expect(csp.get('default-src')).toEqual(["'none'"])
    expect(csp.get('object-src')).toEqual(["'none'"])
    expect(buildCsp({ dev: true })).not.toMatch(/https?:/)
    expect(buildCsp({ dev: true })).not.toContain('unsafe-eval')
  })
})
