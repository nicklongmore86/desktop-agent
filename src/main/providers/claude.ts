import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { launch, killRuntime } from './runtime'
import {
  createSdkMcpServer,
  query,
  tool,
  type Options,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'
import type { AgentTool, RunResult } from '../agent'
import { DEFAULT_SYSTEM_PROMPT } from '../agent'
import type { AgentRunner } from '../chat/session'
import { ToolBridge, transcriptPrompt } from './bridge'
import type { RuntimeContext } from './codex'

export function claudeOptions(context: RuntimeContext): Options {
  return {
    pathToClaudeCodeExecutable: context.file,
    cwd: context.cwd,
    env: context.env,
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    plugins: [],
    skills: [],
    agents: {},
    extraArgs: { bare: null, 'disable-slash-commands': null },
    managedSettings: { disableAllHooks: true },
    settings: { disableAllHooks: true },
    persistSession: false,
    includePartialMessages: true,
    maxTurns: 40,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    permissionMode: 'default',
    canUseTool: () =>
      Promise.resolve({
        behavior: 'deny',
        message: 'Only Desktop Agent tools are permitted.',
      }),
  }
}

export function createClaudeSubscriptionRunner(
  context: RuntimeContext,
  tools: AgentTool[],
): AgentRunner {
  return {
    async run(conversation, options): Promise<RunResult> {
      const bridge = new ToolBridge(conversation, tools, options)
      let child: ChildProcessWithoutNullStreams | undefined
      const abortController = new AbortController()
      const abort = () => {
        abortController.abort()
        if (child) void killRuntime(child)
      }
      options.signal.addEventListener('abort', abort, { once: true })
      const timer = setTimeout(abort, 180000)
      let releaseInput: () => void = () => {}
      let stream: ReturnType<typeof query> | undefined
      try {
        options.signal.throwIfAborted()
        const server = createSdkMcpServer({
          name: 'desktop',
          version: '1.0.0',
          tools: tools.map((appTool) => {
            const shape: Record<string, z.ZodType> = {}
            for (const [key, schema] of Object.entries(appTool.inputSchema.properties)) {
              const field = z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema)
              shape[key] = appTool.inputSchema.required?.includes(key) ? field : field.optional()
            }
            return tool(appTool.name, appTool.description, shape, async (input) => {
              const result = await bridge.call(appTool.name, input)
              return {
                content: [{ type: 'text', text: result.content }],
                isError: result.isError ?? false,
              }
            })
          }),
        })
        const allowedTools = tools.map((t) => `mcp__desktop__${t.name}`)
        const ready = new Promise<void>((resolve) => {
          releaseInput = resolve
        })
        async function* input(): AsyncGenerator<SDKUserMessage> {
          await ready
          if (!abortController.signal.aborted)
            yield {
              type: 'user',
              message: { role: 'user', content: transcriptPrompt(conversation) },
              parent_tool_use_id: null,
              session_id: '',
            }
        }
        stream = query({
          prompt: input(),
          options: {
            ...claudeOptions(context),
            abortController,
            spawnClaudeCodeProcess: (spawnOptions) => {
              if (spawnOptions.command !== context.file)
                throw new Error('Unexpected Claude executable.')
              child = launch(context.file, spawnOptions.args, context.cwd, spawnOptions.env)
              child.stderr.resume()
              return child
            },
            mcpServers: { desktop: server },
            allowedTools,
          },
        })
        const account = await stream.accountInfo()
        if (
          account.apiProvider !== 'firstParty' ||
          (account.apiKeySource && account.apiKeySource !== 'none') ||
          !account.subscriptionType ||
          account.tokenSource === 'none'
        )
          throw new Error('Claude subscription sign-in required. API credentials are not accepted.')
        releaseInput()
        let completed = false
        for await (const message of stream) {
          options.signal.throwIfAborted()
          if (message.type === 'system' && message.subtype === 'init') {
            if (
              message.tools.some((name) => !allowedTools.includes(name)) ||
              message.apiKeySource !== 'none'
            )
              throw new Error(
                'Unsupported Claude configuration: unexpected tools or API authentication.',
              )
          }
          if (
            message.type === 'stream_event' &&
            message.event.type === 'content_block_delta' &&
            message.event.delta.type === 'text_delta'
          )
            bridge.delta(message.event.delta.text)
          if (message.type === 'assistant' && message.error) {
            if (message.error === 'rate_limit' || message.error === 'billing_error')
              throw new Error(
                'Claude subscription usage limit reached. Check your plan or wait for reset.',
              )
            if (message.error === 'authentication_failed')
              throw new Error('Claude sign-in expired. Sign in again in Settings.')
            throw new Error('Claude subscription request failed: ' + message.error)
          }
          if (message.type === 'result') {
            if (message.subtype !== 'success' || message.is_error)
              throw new Error(
                'Claude subscription request failed. Check your sign-in and usage allowance.',
              )
            completed = true
          }
        }
        if (!completed) throw new Error('Claude ended without a completed response.')
        bridge.flush()
        return { conversation: bridge.history, stopReason: 'end_turn' }
      } catch (error) {
        const code = options.signal.aborted ? 'aborted' : 'api'
        options.onEvent({
          type: 'error',
          code,
          message: options.signal.aborted
            ? 'Reply stopped.'
            : error instanceof Error
              ? error.message
              : 'Claude subscription failed.',
        })
        bridge.flush()
        return { conversation: bridge.history, stopReason: code }
      } finally {
        clearTimeout(timer)
        options.signal.removeEventListener('abort', abort)
        abortController.abort()
        releaseInput()
        stream?.close()
        if (child) await killRuntime(child)
      }
    },
  }
}
