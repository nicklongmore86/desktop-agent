// read_document's page images reach real provider requests through the agent loop and
// each client's own image form: the Claude API's tool_result, and the user message an
// OpenAI-compatible server gets after the tool message. Fake servers on 127.0.0.1.
import Anthropic from '@anthropic-ai/sdk'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createAgent, type AgentClient } from '../agent'
import { makePdf, pngShell } from '../documents/fixtures.test-util'
import type { DocumentReader, DocumentView } from '../documents/types'
import { createOpenAICompatClient } from '../llm/openai-compat'
import {
  chunk,
  fakeServer,
  sse,
  toolDelta,
  type FakeServer,
  type Recorded,
} from '../llm/openai-compat/test-support'
import { makeSandbox, put, type Sandbox } from '../permissions/test-support'
import { toolHarness } from './test-support'

const PAGE = pngShell(12, 16)
const PAGE_B64 = Buffer.from(PAGE).toString('base64')
const view: DocumentView = {
  meta: { kind: 'pdf', mime: 'application/pdf', pageCount: 2 },
  sections: [
    { page: 1, text: 'Site plan' },
    { page: 2, text: '' },
  ],
  images: [{ bytes: PAGE, mime: 'image/png', width: 12, height: 16, source: { page: 2 } }],
  position: { unit: 'page', total: 2, shown: { from: 1, to: 2 }, next: null },
  warnings: [],
}
const documents: DocumentReader = { extract: () => Promise.resolve(view) }

let sb: Sandbox
let server: FakeServer
let file: string
beforeEach(async () => {
  sb = await makeSandbox()
  server = await fakeServer()
  file = path.join(sb.root, 'plan.pdf')
  await put(file, Buffer.from(makePdf([{ text: ['Site plan'] }, { drawing: true }])))
})
afterEach(async () => {
  await server.close()
  await sb.cleanup()
})

async function runWith(client: AgentClient, vision: boolean) {
  const tools = Object.values(toolHarness(sb, { documents }).tools)
  const agent = createAgent({ client, tools, vision })
  return agent.run([{ role: 'user', content: 'What is on page 2 of plan.pdf?' }], {
    signal: new AbortController().signal,
    onEvent: () => {},
    requestApproval: () => Promise.resolve(true),
  })
}

/** The Messages API's stream for one assistant message. */
function anthropicStream(
  content: (
    { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown }
  )[],
  stopReason: string,
) {
  return (_req: Recorded, res: ServerResponse): void => {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (event: Record<string, unknown> & { type: string }): void => {
      res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    }
    send({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-test',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })
    content.forEach((block, index) => {
      if (block.type === 'text') {
        send({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } })
        send({
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: block.text },
        })
      } else {
        send({
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        })
        send({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        })
      }
      send({ type: 'content_block_stop', index })
    })
    send({
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    })
    send({ type: 'message_stop' })
    res.end()
  }
}

describe('read_document images reach the providers', () => {
  it('Claude API: the page image inside the tool_result, after its label', async () => {
    server.reply(
      anthropicStream(
        [{ type: 'tool_use', id: 'toolu_1', name: 'read_document', input: { path: file } }],
        'tool_use',
      ),
      anthropicStream([{ type: 'text', text: 'A drawing.' }], 'end_turn'),
    )
    const client = new Anthropic({ apiKey: 'sk-ant-test', baseURL: server.origin, maxRetries: 0 })
    const result = await runWith(client, true)
    expect(result.stopReason).toBe('end_turn')
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/messages', '/v1/messages'])
    const body = server.requests[1]?.body as {
      messages: { role: string; content: { type: string; content?: unknown }[] }[]
    }
    const toolResult = body.messages[2]?.content[0] as {
      type: string
      tool_use_id: string
      content: unknown[]
    }
    expect(toolResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' })
    expect(toolResult.content.slice(1)).toEqual([
      { type: 'text', text: '[Image: page 2]' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PAGE_B64 } },
    ])
    // The saved history keeps a note, never the bytes.
    expect(JSON.stringify(result.conversation)).not.toContain(PAGE_B64)
  })

  it('OpenAI-compatible with vision: the image in a user message after the tool message', async () => {
    server.reply(
      sse([
        chunk(
          toolDelta(0, {
            id: 'call_1',
            name: 'read_document',
            args: JSON.stringify({ path: file }),
          }),
        ),
        chunk({}, 'tool_calls'),
      ]),
      sse([chunk({ content: 'A drawing.' }), chunk({}, 'stop')]),
    )
    const client = createOpenAICompatClient({
      baseUrl: server.baseUrl,
      flavor: 'ollama',
      model: 'llava',
    })
    const result = await runWith(client, true)
    expect(result.stopReason).toBe('end_turn')
    const body = server.requests[1]?.body as {
      messages: { role: string; content: unknown; tool_call_id?: string }[]
    }
    expect(body.messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ])
    expect(body.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    expect(body.messages[4]?.content).toEqual(
      expect.arrayContaining([
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PAGE_B64}` } },
      ]),
    )
  })

  it('OpenAI-compatible without vision: a note in the tool message, no bytes', async () => {
    server.reply(
      sse([
        chunk(
          toolDelta(0, {
            id: 'call_1',
            name: 'read_document',
            args: JSON.stringify({ path: file }),
          }),
        ),
        chunk({}, 'tool_calls'),
      ]),
      sse([chunk({ content: 'Text only.' }), chunk({}, 'stop')]),
    )
    const client = createOpenAICompatClient({
      baseUrl: server.baseUrl,
      flavor: 'ollama',
      model: 'llama3',
    })
    await runWith(client, false)
    const text = JSON.stringify(server.requests[1]?.body)
    expect(text).not.toContain(PAGE_B64)
    expect(text).not.toContain('image_url')
    expect(text).toContain('This model cannot see images')
  })
})
