import { describe, expect, it } from 'vitest'
import { isAppUrl, secureWebPreferences } from './security'

describe('secureWebPreferences', () => {
  it('locks down the renderer', () => {
    expect(secureWebPreferences('/app/preload.js')).toMatchObject({
      preload: '/app/preload.js',
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
    })
  })
})

describe('isAppUrl', () => {
  const devUrl = 'http://localhost:5173/'
  const fileUrl =
    'file:///C:/Program%20Files/Desktop%20Agent/resources/app.asar/out/renderer/index.html'

  it('allows the dev server origin', () => {
    expect(isAppUrl('http://localhost:5173/', devUrl)).toBe(true)
    expect(isAppUrl('http://localhost:5173/index.html#chat', devUrl)).toBe(true)
  })

  it('rejects other origins in dev', () => {
    expect(isAppUrl('http://localhost:5174/', devUrl)).toBe(false)
    expect(isAppUrl('https://example.com/', devUrl)).toBe(false)
    expect(isAppUrl('file:///etc/passwd', devUrl)).toBe(false)
  })

  it('allows only the packaged index.html for file URLs', () => {
    expect(isAppUrl(fileUrl, fileUrl)).toBe(true)
    expect(isAppUrl(`${fileUrl}#settings`, fileUrl)).toBe(true)
    expect(isAppUrl('file:///C:/Windows/System32/drivers/etc/hosts', fileUrl)).toBe(false)
    expect(isAppUrl('https://example.com/', fileUrl)).toBe(false)
  })

  it('rejects unparseable URLs', () => {
    expect(isAppUrl('not a url', devUrl)).toBe(false)
    expect(isAppUrl(devUrl, 'not a url')).toBe(false)
  })
})
