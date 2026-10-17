// Gemini API (API key) model client. Google-account sign-in (Gemini CLI or
// Antigravity OAuth, Google AI Pro/Ultra plans) is deliberately not supported.
export { createGeminiClient, type GeminiClientOptions } from './client'
export { GeminiError, geminiErrorEvent } from './errors'
export { listGeminiModels, validateGeminiKey, type GeminiModel } from './models'
export { GEMINI_HOST } from './types'

/**
 * Shown before a free-tier key is used. Google's pricing page lists free-tier
 * content as "Used to improve our products" and paid-tier content as not.
 */
export const GEMINI_FREE_TIER_NOTICE = {
  title: 'Free Gemini API keys share your data with Google',
  text: 'On the Gemini API free tier, Google may use your prompts, files the agent reads and the responses to improve its products, and people may review them. Do not use a free key with confidential or personal information. Paid-tier usage is not used this way.',
  links: [
    { label: 'Gemini API pricing', url: 'https://ai.google.dev/gemini-api/docs/pricing' },
    { label: 'Gemini API terms', url: 'https://ai.google.dev/gemini-api/terms' },
  ],
} as const
