import { describe, expect, it } from 'vitest'
import { isToolFormatError, responsesError, toolFormatMessage } from './errors'

describe('tool-format rejections', () => {
  it.each([
    [400, { code: 'invalid_value', param: 'tools[0].type' }],
    [400, { param: 'tools[0].tools[3].strict' }],
    [422, { code: 'unknown_parameter', param: 'tools[0].namespace' }],
    [400, { code: 'subscription_sharing_unsupported_capability', param: 'tools' }],
    [400, { code: 'invalid_value', param: 'input[4].namespace' }],
    // In-stream (response.failed): no HTTP status.
    [undefined, { code: 'invalid_tool', param: 'tools[0]' }],
  ])('maps %s %j to its own message naming the field', (status, error) => {
    const mapped = responsesError({ ...error, message: 'Bad tool: SECRET' }, status)
    expect(isToolFormatError(mapped)).toBe(true)
    expect(mapped).toMatchObject({ code: 'invalid_request', retryable: false })
    expect(mapped.message.startsWith(toolFormatMessage(error.param))).toBe(true)
    expect(mapped.message).toContain(`param ${error.param}`)
    expect(mapped.message).not.toContain('SECRET')
  })

  it.each([
    [400, { code: 'invalid_value', param: 'model' }],
    [400, { code: 'invalid_value', param: 'input[0].content' }],
    // A documented code keeps its own mapping even when a tool field is named.
    [429, { code: 'subscription_sharing_usage_limit_exceeded', param: 'tools' }],
    [500, { param: 'tools[0]' }],
    // Not a field path: dropped, so not reported as a tool problem.
    [400, { param: 'tools[0] <script>' }],
  ])('leaves %s %j alone', (status, error) => {
    const mapped = responsesError(error, status)
    expect(isToolFormatError(mapped)).toBe(false)
    expect(mapped.message).not.toMatch(/tool format/)
  })
})
