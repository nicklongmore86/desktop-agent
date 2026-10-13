import { describe, expect, it } from 'vitest'
import { isAppUrl, isLoopbackHttpUrl, secureWebPreferences } from './security'

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

  it('rejects file URLs on another host, including UNC paths', () => {
    const sameDiskPath = new URL(fileUrl).pathname
    expect(isAppUrl(`file://attacker${sameDiskPath}`, fileUrl)).toBe(false)
    expect(isAppUrl(`file://server/share${sameDiskPath}`, fileUrl)).toBe(false)
    expect(isAppUrl('file://server/share/out/renderer/index.html', fileUrl)).toBe(false)
  })

  it('rejects unparseable URLs', () => {
    expect(isAppUrl('not a url', devUrl)).toBe(false)
    expect(isAppUrl(devUrl, 'not a url')).toBe(false)
  })
})

describe('isLoopbackHttpUrl', () => {
  it('accepts http on loopback hosts with any port', () => {
    expect(isLoopbackHttpUrl('http://localhost:5173/')).toBe(true)
    expect(isLoopbackHttpUrl('http://127.0.0.1:5173')).toBe(true)
    expect(isLoopbackHttpUrl('http://[::1]:5173/')).toBe(true)
    expect(isLoopbackHttpUrl('http://localhost/')).toBe(true)
  })

  it('rejects https, non-loopback hosts and other schemes', () => {
    expect(isLoopbackHttpUrl('https://localhost:5173/')).toBe(false)
    expect(isLoopbackHttpUrl('http://example.com/')).toBe(false)
    expect(isLoopbackHttpUrl('http://localhost.example.com/')).toBe(false)
    expect(isLoopbackHttpUrl('http://192.168.1.10:5173/')).toBe(false)
    expect(isLoopbackHttpUrl('file:///C:/index.html')).toBe(false)
    expect(isLoopbackHttpUrl('not a url')).toBe(false)
  })
})
