import { describe, expect, it } from 'vitest'
import { MAX_EVENT_BYTES, sseData } from './stream'
import { splitEvent } from './test-support'

function body(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part))
      controller.close()
    },
  })
}
async function collect(parts: string[]): Promise<string[]> {
  const out: string[] = []
  for await (const data of sseData(body(parts), () => {})) out.push(data)
  return out
}
const linesPast = Math.ceil(MAX_EVENT_BYTES / 1024) + 16

describe('sseData', () => {
  it('joins an event split over several data lines', async () => {
    expect(
      await collect(['data: {"a":\n', 'data: 1}\n', '\n', ': comment\n\n', 'data: [DONE]\n\n']),
    ).toEqual(['{"a":\n1}'])
  })

  it('rejects an event split over many short data lines past the per-event bound', async () => {
    await expect(collect(splitEvent({ id: 1 }, linesPast))).rejects.toMatchObject({
      code: 'protocol',
      message: expect.stringMatching(/oversized stream event/) as unknown,
    })
  })

  it('rejects an unterminated split event at the end of the body', async () => {
    const parts = splitEvent({ id: 1 }, linesPast)
    // No blank line after the last data line: the end of the body dispatches it.
    parts[parts.length - 1] = 'data: ""]}'
    await expect(collect(parts)).rejects.toMatchObject({ code: 'protocol' })
  })

  it('rejects an oversized line that never ends, without waiting for the body to end', async () => {
    const encoder = new TextEncoder()
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: "${'x'.repeat(MAX_EVENT_BYTES + 1024)}`))
        // Never closed.
      },
    })
    await expect(sseData(open, () => {}).next()).rejects.toMatchObject({ code: 'protocol' })
  })

  it('counts each event separately', async () => {
    const event = splitEvent({ id: 1 }, Math.floor(linesPast / 4))
    const events = await collect(Array.from({ length: 6 }, () => event).flat())
    expect(events).toHaveLength(6)
    expect(JSON.parse(events[0] ?? '')).toMatchObject({ id: 1 })
  })

  it('does not count comment lines toward an event', async () => {
    const comments = Array.from({ length: linesPast }, () => `: ${'x'.repeat(1024)}\n`)
    expect(await collect([...comments, 'data: {"ok":true}\n\n'])).toEqual(['{"ok":true}'])
  })
})
