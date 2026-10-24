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
import { imageLabel, ToolBridge, transcriptInput } from './bridge'
import { CLAUDE_FAILURES, SubscriptionError, mapFailure, plausibleReset } from './errors'
import type { ProviderFailure } from '../../shared/ipc'
import type { RuntimeContext } from './codex'

export function claudeOptions(context: RuntimeContext): Options {
  return {
    pathToClaudeCodeExecutable: context.file,
    cwd: context.cwd,
    // Not --bare: bare mode (CLAUDE_CODE_SIMPLE) never reads the subscription sign-in.
    // These cover the parts of bare mode that isolation does not already disable.
    env: {
      ...context.env,
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    },
    tools: [],
    settingSources: [],
    strictMcpConfig: true,
    plugins: [],
    skills: [],
    agents: {},
    extraArgs: { 'disable-slash-commands': null },
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
  observe: {
    onLimit?: (resetsAt: string | undefined) => void
    onAvailable?: () => void
    onAccount?: (plan: string) => void
    onFailure?: (failure: ProviderFailure) => void
  } = {},
): AgentRunner {
  return {
    // Every Claude model the subscription offers reads images.
    vision: true,
    async run(conversation, options): Promise<RunResult> {
      let child: ChildProcessWithoutNullStreams | undefined
      const abortController = new AbortController()
      const bridge = new ToolBridge(conversation, tools, {
        ...options,
        signal: abortController.signal,
        vision: true,
      })
      const prompt = transcriptInput(conversation, true)
      bridge.spendImages(prompt.images.length)
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
              const { result, images } = await bridge.call(appTool.name, input)
              // MCP image content: the runtime turns it into image blocks in its tool_result.
              return {
                content: [
                  { type: 'text', text: result.content },
                  ...images.flatMap(({ label, block }) =>
                    block.source.type === 'base64'
                      ? [
                          { type: 'text' as const, text: imageLabel(label) },
                          {
                            type: 'image' as const,
                            data: block.source.data,
                            mimeType: block.source.media_type,
                          },
                        ]
                      : [],
                  ),
                ],
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
              message: {
                role: 'user',
                content: prompt.images.length
                  ? [
                      { type: 'text', text: prompt.text },
                      ...prompt.images.flatMap(({ label, block }) => [
                        { type: 'text' as const, text: imageLabel(label) },
                        block,
                      ]),
                    ]
                  : prompt.text,
              },
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
        if (account.apiKeySource && account.apiKeySource !== 'none')
          throw new SubscriptionError(
            'authentication',
            'Claude subscription sign-in required. API credentials are not accepted.',
          )
        if (account.apiProvider !== 'firstParty')
          throw new SubscriptionError(
            'authentication',
            'Claude subscription sign-in required. Cloud API providers are not accepted.',
          )
        if (!account.subscriptionType || account.tokenSource === 'none')
          throw new Error("Claude isn't signed in with a subscription. Sign in again in Settings.")
        observe.onAccount?.(account.subscriptionType)
        if (/^(?:claude\s*)?free$/i.test(account.subscriptionType))
          throw new SubscriptionError(
            'plan_not_entitled',
            "Your Claude plan doesn't include Claude Code. Claude Pro or Max is required.",
          )
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
          if (message.type === 'rate_limit_event' && message.rate_limit_info.status !== 'rejected')
            observe.onAvailable?.()
          if (
            message.type === 'rate_limit_event' &&
            message.rate_limit_info.status === 'rejected'
          ) {
            observe.onLimit?.(plausibleReset(message.rate_limit_info.resetsAt))
            throw mapFailure(
              { code: 'usage_limit', resetsAt: message.rate_limit_info.resetsAt },
              CLAUDE_FAILURES,
            )
          }
          if (message.type === 'assistant' && message.error)
            throw mapFailure({ code: message.error, message: message.message }, CLAUDE_FAILURES)
          if (message.type === 'result') {
            if (message.subtype !== 'success' || message.is_error)
              throw mapFailure(
                {
                  ...message,
                  errors: 'errors' in message ? message.errors : [],
                  result: 'result' in message ? message.result : '',
                },
                CLAUDE_FAILURES,
              )
            completed = true
          }
        }
        if (!completed) throw new Error('Claude ended without a completed response.')
        observe.onAvailable?.()
        bridge.flush()
        return { conversation: structuredClone(bridge.history), stopReason: 'end_turn' }
      } catch (error) {
        const failure = mapFailure(error, CLAUDE_FAILURES)
        const code = options.signal.aborted ? 'aborted' : failure.code
        if (!options.signal.aborted) observe.onFailure?.(failure)
        options.onEvent({
          type: 'error',
          code,
          message: options.signal.aborted ? 'Reply stopped.' : failure.message,
          ...(failure.resetsAt ? { resetsAt: failure.resetsAt } : {}),
        })
        bridge.flush()
        return { conversation: structuredClone(bridge.history), stopReason: code }
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
