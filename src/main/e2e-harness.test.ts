import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { secureWebPreferences } from './security'

const require = createRequire(import.meta.url)
const { harnessWebPreferences } = require('../../e2e/harness/web-preferences.cjs') as {
  harnessWebPreferences: (preload: string) => unknown
}

describe('e2e rendering harness', () => {
  it('uses exactly the app window’s web preferences', () => {
    expect(harnessWebPreferences('preload.js')).toEqual(secureWebPreferences('preload.js'))
  })
})
