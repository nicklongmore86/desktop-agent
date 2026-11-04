import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { TEST_ONLY } from './app-files.mjs'

it('afterPack checks every main bundle electron-builder.yml leaves out', async () => {
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  const excluded = [...config.matchAll(/^\s*- '!(out\/main\/[^']+\.js)'\r?$/gm)].map(
    (match) => match[1],
  )
  expect(excluded).toContain('out/main/network.js')
  expect([...TEST_ONLY].sort()).toEqual(excluded.sort())
})
