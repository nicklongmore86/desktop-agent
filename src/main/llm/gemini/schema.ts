import type { GeminiSchema, GeminiType } from './types'

// Gemini's `parameters` take "a select subset of the OpenAPI schema format"
// (https://ai.google.dev/gemini-api/docs/generate-content/function-calling).
// Keywords outside that subset are rewritten when there is a safe equivalent
// and dropped otherwise: a dropped keyword only loosens what the model is
// told, and every tool still validates its own input before running.

const MAX_DEPTH = 24
const TYPES: Record<string, GeminiType> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
}
const FORMATS: Partial<Record<GeminiType, string[]>> = {
  STRING: ['enum', 'date-time'],
  NUMBER: ['float', 'double'],
  INTEGER: ['int32', 'int64'],
}

type Node = Record<string, unknown>
const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const count = (value: unknown): string | undefined =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? String(value) : undefined
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** Converts a tool's JSON Schema into Gemini's schema subset. Never throws. */
export function toGeminiSchema(schema: unknown): GeminiSchema {
  const root = isNode(schema) ? schema : {}

  function resolve(node: Node, seen: Set<string>): Node | undefined {
    const ref = node.$ref
    if (typeof ref !== 'string') return node
    const match = /^#\/(\$defs|definitions)\/([^/]+)$/.exec(ref)
    const defs = match ? root[match[1] ?? ''] : undefined
    const target = match && isNode(defs) ? defs[match[2] ?? ''] : undefined
    // Unresolvable and recursive references cannot be expressed: treat them as "anything".
    if (!isNode(target) || seen.has(ref)) return undefined
    seen.add(ref)
    const { $ref: _ref, ...rest } = node
    return { ...target, ...rest }
  }

  /** Folds `allOf` members into the node: properties and requirements are combined. */
  function flatten(node: Node, depth: number, seen: Set<string>): Node {
    if (!Array.isArray(node.allOf) || depth > MAX_DEPTH) return node
    const { allOf, ...merged } = node
    const properties: Node = isNode(merged.properties) ? { ...merged.properties } : {}
    const required = new Set(Array.isArray(merged.required) ? merged.required : [])
    for (const raw of allOf as unknown[]) {
      const scope = new Set(seen)
      const member = isNode(raw) ? resolve(raw, scope) : undefined
      if (!member) continue
      const flat = flatten(member, depth + 1, scope)
      for (const [key, value] of Object.entries(flat))
        if (key !== 'properties' && key !== 'required' && !(key in merged)) merged[key] = value
      if (isNode(flat.properties)) Object.assign(properties, flat.properties)
      if (Array.isArray(flat.required)) for (const name of flat.required) required.add(name)
    }
    if (Object.keys(properties).length) merged.properties = properties
    if (required.size) merged.required = [...required]
    return merged
  }

  function convert(raw: unknown, depth: number, seen: Set<string>): GeminiSchema {
    // Each branch tracks the refs it is inside, so recursive definitions stop.
    const scope = new Set(seen)
    const resolved = isNode(raw) && depth <= MAX_DEPTH ? resolve(raw, scope) : undefined
    if (!resolved) return { type: 'STRING' }
    const node = flatten(resolved, depth, scope)
    const description = typeof node.description === 'string' ? node.description : undefined
    const base: GeminiSchema = {}
    if (typeof node.title === 'string') base.title = node.title
    if (description !== undefined) base.description = description
    const declared = (Array.isArray(node.type) ? node.type : [node.type]).filter(
      (t): t is string => typeof t === 'string',
    )
    if (declared.includes('null') || node.nullable === true) base.nullable = true
    const types = declared.filter((t) => t !== 'null')

    const variants = Array.isArray(node.anyOf)
      ? node.anyOf
      : Array.isArray(node.oneOf)
        ? node.oneOf
        : undefined
    if (variants && !types.length) {
      const nonNull = variants.filter((v) => !(isNode(v) && v.type === 'null'))
      if (nonNull.length !== variants.length) base.nullable = true
      const options = nonNull.map((v) => convert(v, depth + 1, scope))
      const [only] = options
      if (options.length === 1 && only) return { ...only, ...base }
      if (options.length > 1) return { ...base, anyOf: options }
    }
    if (types.length > 1)
      return {
        ...base,
        anyOf: types.map((t) => {
          const { type: _type, description: _description, title: _title, ...rest } = node
          return convert({ ...rest, type: t }, depth + 1, scope)
        }),
      }

    const type = TYPES[types[0] ?? ''] ?? inferType(node)
    const out: GeminiSchema = { type, ...base }
    if (typeof node.format === 'string' && FORMATS[type]?.includes(node.format))
      out.format = node.format
    const values = Array.isArray(node.enum) ? node.enum : 'const' in node ? [node.const] : undefined
    if (values) {
      if (type === 'STRING' && values.every((v) => typeof v === 'string')) out.enum = values
      else note(out, `Allowed values: ${values.map((v) => JSON.stringify(v)).join(', ')}.`)
    }
    const fallback = node.default
    if (
      (typeof fallback === 'string' && type === 'STRING') ||
      (typeof fallback === 'boolean' && type === 'BOOLEAN') ||
      (finite(fallback) && (type === 'NUMBER' || type === 'INTEGER'))
    )
      out.default = fallback
    const example: unknown =
      'example' in node ? node.example : Array.isArray(node.examples) ? node.examples[0] : undefined
    if (example !== undefined && typeof example !== 'object') out.example = example

    switch (type) {
      case 'STRING': {
        const minLength = count(node.minLength)
        const maxLength = count(node.maxLength)
        if (minLength) out.minLength = minLength
        if (maxLength) out.maxLength = maxLength
        if (typeof node.pattern === 'string') out.pattern = node.pattern
        break
      }
      case 'NUMBER':
      case 'INTEGER': {
        // Exclusive bounds become inclusive ones: exact for integers, a tiny widening otherwise.
        const step = type === 'INTEGER' ? 1 : 0
        if (finite(node.minimum)) out.minimum = node.minimum
        else if (finite(node.exclusiveMinimum)) out.minimum = node.exclusiveMinimum + step
        if (finite(node.maximum)) out.maximum = node.maximum
        else if (finite(node.exclusiveMaximum)) out.maximum = node.exclusiveMaximum - step
        break
      }
      case 'ARRAY': {
        const items: unknown = Array.isArray(node.items) ? node.items[0] : node.items
        out.items = convert(items ?? node.prefixItems, depth + 1, scope)
        const minItems = count(node.minItems)
        const maxItems = count(node.maxItems)
        if (minItems) out.minItems = minItems
        if (maxItems) out.maxItems = maxItems
        break
      }
      case 'OBJECT': {
        const declared = isNode(node.properties) ? node.properties : {}
        const properties = Object.entries(declared)
        if (properties.length) {
          out.properties = Object.fromEntries(
            properties.map(([key, value]) => [key, convert(value, depth + 1, scope)]),
          )
          const required = Array.isArray(node.required)
            ? node.required.filter(
                (name, i, all): name is string =>
                  typeof name === 'string' && name in declared && all.indexOf(name) === i,
              )
            : []
          if (required.length) out.required = required
        }
        const minProperties = count(node.minProperties)
        const maxProperties = count(node.maxProperties)
        if (minProperties) out.minProperties = minProperties
        if (maxProperties) out.maxProperties = maxProperties
        break
      }
      case 'BOOLEAN':
        break
    }
    return out
  }

  return convert(root, 0, new Set())
}

function inferType(node: Node): GeminiType {
  if (isNode(node.properties)) return 'OBJECT'
  if (node.items !== undefined || node.prefixItems !== undefined) return 'ARRAY'
  const sample: unknown = Array.isArray(node.enum) ? node.enum[0] : node.const
  if (typeof sample === 'number') return Number.isInteger(sample) ? 'INTEGER' : 'NUMBER'
  if (typeof sample === 'boolean') return 'BOOLEAN'
  // No type at all means "any value"; Gemini has no such type, so a string is the safe carrier.
  return 'STRING'
}

function note(schema: GeminiSchema, text: string): void {
  schema.description = schema.description ? `${schema.description} ${text}` : text
}
