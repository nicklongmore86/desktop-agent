import { describe, expect, it } from 'vitest'
import { makeSandbox } from '../../permissions/test-support'
import { toolHarness } from '../../tools/test-support'
import { toGeminiSchema } from './schema'
import type { GeminiSchema } from './types'

const ALLOWED = new Set([
  'type',
  'format',
  'title',
  'description',
  'nullable',
  'enum',
  'default',
  'example',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'items',
  'properties',
  'required',
  'minProperties',
  'maxProperties',
  'anyOf',
])

/** Every key at every level is one Gemini's Schema accepts. */
function expectSubset(schema: GeminiSchema): void {
  for (const key of Object.keys(schema)) expect(ALLOWED).toContain(key)
  if (schema.items) expectSubset(schema.items)
  for (const child of Object.values(schema.properties ?? {})) expectSubset(child)
  for (const child of schema.anyOf ?? []) expectSubset(child)
}

describe('toGeminiSchema', () => {
  it('converts the basic types and keeps supported constraints', () => {
    const out = toGeminiSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: {
        path: { type: 'string', description: 'Absolute path.', minLength: 1, pattern: '^/' },
        depth: { type: 'integer', minimum: 1, maximum: 5, default: 1 },
        ratio: { type: 'number', exclusiveMinimum: 0 },
        tags: { type: 'array', items: { type: 'string' }, maxItems: 3, uniqueItems: true },
        recursive: { type: 'boolean' },
      },
      required: ['path', 'missing', 'path'],
    })
    expect(out).toEqual({
      type: 'OBJECT',
      properties: {
        path: { type: 'STRING', description: 'Absolute path.', minLength: '1', pattern: '^/' },
        depth: { type: 'INTEGER', minimum: 1, maximum: 5, default: 1 },
        ratio: { type: 'NUMBER', minimum: 0 },
        tags: { type: 'ARRAY', items: { type: 'STRING' }, maxItems: '3' },
        recursive: { type: 'BOOLEAN' },
      },
      required: ['path'],
    })
  })

  it('turns nullable type unions, oneOf and const into supported forms', () => {
    const out = toGeminiSchema({
      type: 'object',
      properties: {
        name: { type: ['string', 'null'] },
        either: { type: ['string', 'integer'], description: 'Id or name.' },
        mode: { oneOf: [{ const: 'fast' }, { type: 'null' }] },
        kind: { enum: ['a', 'b'] },
        level: { type: 'integer', enum: [1, 2], exclusiveMaximum: 10 },
        when: { type: 'string', format: 'date-time' },
        uri: { type: 'string', format: 'uri' },
      },
    })
    expect(out.properties).toEqual({
      name: { type: 'STRING', nullable: true },
      either: {
        description: 'Id or name.',
        anyOf: [{ type: 'STRING' }, { type: 'INTEGER' }],
      },
      mode: { type: 'STRING', enum: ['fast'], nullable: true },
      kind: { type: 'STRING', enum: ['a', 'b'] },
      level: { type: 'INTEGER', description: 'Allowed values: 1, 2.', maximum: 9 },
      when: { type: 'STRING', format: 'date-time' },
      uri: { type: 'STRING' },
    })
  })

  it('resolves local refs and allOf, and survives recursive or unknown schemas', () => {
    const out = toGeminiSchema({
      $defs: { node: { type: 'object', properties: { child: { $ref: '#/$defs/node' } } } },
      allOf: [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] },
        { properties: { tree: { $ref: '#/$defs/node' }, gone: { $ref: 'https://x/y' } } },
      ],
      patternProperties: { '^x': { type: 'string' } },
    })
    expectSubset(out)
    expect(out.type).toBe('OBJECT')
    expect(out.required).toEqual(['a'])
    expect(out.properties?.tree?.properties?.child).toEqual({ type: 'STRING' })
    expect(out.properties?.gone).toEqual({ type: 'STRING' })
    expect(toGeminiSchema(null)).toEqual({ type: 'STRING' })
    expect(toGeminiSchema({ properties: {} })).toEqual({ type: 'OBJECT' })
  })

  it('caps very deep schemas', () => {
    let deep: Record<string, unknown> = { type: 'string' }
    for (let i = 0; i < 100; i++) deep = { type: 'object', properties: { x: deep } }
    let depth = 0
    for (let s: GeminiSchema | undefined = toGeminiSchema(deep); s; s = s.properties?.x) depth++
    expect(depth).toBeLessThan(30)
  })

  it('converts every built-in tool schema into the subset', async () => {
    const sb = await makeSandbox()
    try {
      const tools = Object.values(toolHarness(sb).tools)
      expect(tools.length).toBeGreaterThan(5)
      for (const tool of tools) {
        const out = toGeminiSchema(tool.inputSchema)
        expectSubset(out)
        expect(out.type).toBe('OBJECT')
        expect(Object.keys(out.properties ?? {})).toEqual(Object.keys(tool.inputSchema.properties))
      }
    } finally {
      await sb.cleanup()
    }
  })
})
