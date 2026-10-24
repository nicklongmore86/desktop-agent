// The subset of the Gemini API (v1beta, generateContent) wire format this client uses.
// Reference: https://ai.google.dev/api/generate-content

export const GEMINI_HOST = 'https://generativelanguage.googleapis.com'

export type GeminiType = 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT'

/** The OpenAPI-subset `Schema` accepted in `FunctionDeclaration.parameters`. */
export interface GeminiSchema {
  type?: GeminiType
  format?: string
  title?: string
  description?: string
  nullable?: boolean
  enum?: string[]
  default?: string | number | boolean
  example?: unknown
  minLength?: string
  maxLength?: string
  pattern?: string
  minimum?: number
  maximum?: number
  minItems?: string
  maxItems?: string
  items?: GeminiSchema
  properties?: Record<string, GeminiSchema>
  required?: string[]
  minProperties?: string
  maxProperties?: string
  anyOf?: GeminiSchema[]
}

export interface GeminiFunctionDeclaration {
  name: string
  description?: string
  parameters?: GeminiSchema
}

export interface GeminiFunctionCall {
  id?: string
  name: string
  args?: unknown
}

/** Inline bytes (base64), for images. */
export interface GeminiBlob {
  mimeType: string
  data: string
}

export interface GeminiFunctionResponse {
  id?: string
  name: string
  response: Record<string, unknown>
  /** Gemini 3 and later: images that belong to this response (multimodal function responses). */
  parts?: { inlineData: GeminiBlob }[]
}

export interface GeminiPart {
  text?: string
  inlineData?: GeminiBlob
  thought?: boolean
  thoughtSignature?: string
  functionCall?: GeminiFunctionCall
  functionResponse?: GeminiFunctionResponse
}

export interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

export interface GeminiRequest {
  contents: GeminiContent[]
  systemInstruction?: { parts: { text: string }[] }
  tools?: { functionDeclarations: GeminiFunctionDeclaration[] }[]
  generationConfig: { maxOutputTokens: number }
}

export interface GeminiUsageMetadata {
  promptTokenCount?: number
  cachedContentTokenCount?: number
  candidatesTokenCount?: number
  toolUsePromptTokenCount?: number
  thoughtsTokenCount?: number
  totalTokenCount?: number
}

export interface GeminiResponseChunk {
  candidates?: {
    content?: { role?: string; parts?: GeminiPart[] }
    finishReason?: string
  }[]
  promptFeedback?: { blockReason?: string }
  usageMetadata?: GeminiUsageMetadata
  modelVersion?: string
  responseId?: string
}

/** What a function call needs to be replayed: Gemini's own id and its thought signature. */
export interface CallRecord {
  geminiId?: string
  signature?: string
}
