import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { fakeServer, json, redirectFetch, type FakeServer } from '../openai-compat/test-support'
import { listChatGPTModels, validateChatGPTToken } from './models'

let server: FakeServer
let seen: string[]
beforeEach(async () => {
  server = await fakeServer()
  seen = []
})
afterEach(async () => {
  await server.close()
})

const TOKEN = 'eyJhbGciOi.SECRET-access-token-0123456789.sig'
const options = () => ({
  getAccessToken: () => Promise.resolve(TOKEN),
  fetch: redirectFetch(server.origin, seen),
})

describe('listChatGPTModels', () => {
  it('keeps listed models in server order, with display names, from the official host', async () => {
    server.reply(
      json(200, {
        models: [
          { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol', visibility: 'list' },
          { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' },
          { slug: 'a-model', display_name: '  ', visibility: 'list' },
          { slug: 'gpt-6.1-sol', display_name: 'Duplicate', visibility: 'list' },
          { slug: 'bad slug/../x', display_name: 'Bad', visibility: 'list' },
          { display_name: 'No slug', visibility: 'list' },
          'junk',
        ],
      }),
    )
    expect(await listChatGPTModels(options())).toEqual([
      { slug: 'gpt-6.1-sol', displayName: 'GPT-6.1 Sol' },
      { slug: 'a-model', displayName: 'a-model' },
    ])
    expect(seen).toEqual(['https://api.openai.com/v1/models'])
    expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models' })
    expect(server.requests[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('rejects a list without models[] as malformed', async () => {
    server.reply(json(200, { data: [{ id: 'gpt-5' }] }))
    await expect(listChatGPTModels(options())).rejects.toMatchObject({ code: 'protocol' })
  })

  it('maps failures with app-written text and no token', async () => {
    server.reply(
      json(401, { error: { code: 'subscription_sharing_invalid_user', message: TOKEN } }),
    )
    const result = await validateChatGPTToken(options())
    expect(result).toMatchObject({ ok: false, code: 'auth_expired' })
    expect(JSON.stringify(result)).not.toContain(TOKEN)

    server.reply(json(200, { models: [] }))
    expect(await validateChatGPTToken(options())).toEqual({ ok: true })
  })
})
