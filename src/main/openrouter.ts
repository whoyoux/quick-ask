// Minimal OpenRouter client: speech-to-text and streamed chat completions.

import type { Source, TokenUsage } from '../shared/types'

export type { Source, TokenUsage }

// Overridable for testing against a local mock server.
const BASE_URL = process.env.QUICK_ASK_API_BASE ?? 'https://openrouter.ai/api/v1'

// Optional attribution headers, see https://openrouter.ai/docs/app-attribution
const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/whoyoux/quick-ask',
  'X-Title': 'Quick Ask'
}

const TIMEOUT_MESSAGE = 'Model nie odpowiedział na czas. Spróbuj ponownie albo zmień model w menu.'
const CONNECTION_LOST_MESSAGE = 'Połączenie z OpenRouter zostało przerwane. Spróbuj ponownie.'
/** Transcription providers give up after 60 s anyway. */
const TRANSCRIPTION_TIMEOUT_MS = 45_000
/** No bytes for this long ends a stream; OpenRouter sends keep-alive comments while a model thinks. */
const STREAM_IDLE_TIMEOUT_MS = 30_000
const KEY_CHECK_TIMEOUT_MS = 15_000
/** Image models take a while, especially the high-quality ones. */
const IMAGE_TIMEOUT_MS = 180_000

export class OpenRouterError extends Error {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'OpenRouterError'
    this.status = status
  }
}

export type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }

/** A reasoning block as OpenRouter reports it; echoed back verbatim during a tool loop. */
export type ReasoningDetail = Record<string, unknown>

export type ChatMessage =
  | { role: 'system' | 'user'; content: string | ContentPart[] }
  | {
      role: 'assistant'
      content: string | null
      tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
      /** Gemini and Claude refuse a tool result unless their reasoning comes back unchanged. */
      reasoning_details?: ReasoningDetail[]
    }
  | { role: 'tool'; tool_call_id: string; content: string }

/** A function the model may call; we run it ourselves. */
export interface FunctionTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ToolCall {
  /** Pairs the call with its result in the next request. */
  id: string
  name: string
  /** JSON text, as the model wrote it. */
  arguments: string
}

export interface KeyInfo {
  label: string | null
  /** USD left under the key's own spending limit; null when the key has no limit. */
  limitRemaining: number | null
  /** USD spent with this key, all time and today (UTC). */
  usage: number | null
  usageDaily: number | null
}

export interface ChatResult {
  /** Everything this request streamed through `onDelta`. */
  text: string
  /** USD, from OpenRouter's usage accounting; null if the response didn't include it. */
  cost: number | null
  tokens: TokenUsage | null
  toolCalls: ToolCall[]
  reasoningDetails: ReasoningDetail[]
}

export interface Transcription {
  text: string
  cost: number | null
  tokens: TokenUsage | null
}

export interface GeneratedImage {
  data: Buffer
  mimeType: string
}

export interface ImageResult {
  images: GeneratedImage[]
  cost: number | null
  tokens: TokenUsage | null
}

/** Chat completions report prompt/completion tokens, the audio and image APIs input/output tokens. */
function tokensOf(usage: unknown): TokenUsage | null {
  const u = usage as Record<string, unknown> | null | undefined
  const input = numberOrNull(u?.prompt_tokens) ?? numberOrNull(u?.input_tokens)
  const output = numberOrNull(u?.completion_tokens) ?? numberOrNull(u?.output_tokens)
  return input === null && output === null ? null : { input: input ?? 0, output: output ?? 0 }
}

function costOf(usage: unknown): number | null {
  const cost = (usage as { cost?: unknown } | null | undefined)?.cost
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : null
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** `url_citation` annotations come either OpenAI-style (nested) or flat; accept both. */
function citation(annotation: unknown): Source | null {
  const a = annotation as { type?: string; url?: unknown; title?: unknown; url_citation?: { url?: unknown; title?: unknown } }
  if (a?.type !== 'url_citation') return null
  const url = a.url_citation?.url ?? a.url
  const title = a.url_citation?.title ?? a.title
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null
  return { url, title: typeof title === 'string' && title.trim() ? title.trim() : new URL(url).hostname }
}

function describeStatus(status: number, detail: string): string {
  switch (status) {
    case 401:
      return 'Klucz API OpenRouter jest nieprawidłowy. Ustaw go ponownie w menu Quick Ask.'
    case 402:
      return 'Brak środków na koncie OpenRouter. Doładuj kredyty na openrouter.ai.'
    case 403:
      return detail ? `OpenRouter odrzucił zapytanie: ${detail}` : 'OpenRouter odrzucił zapytanie.'
    case 408:
      return 'Model nie odpowiedział na czas. Spróbuj ponownie.'
    case 429:
      return 'Za dużo zapytań naraz. Spróbuj za chwilę.'
    case 502:
    case 503:
      return 'Wybrany model jest chwilowo niedostępny. Spróbuj ponownie albo zmień model w menu.'
    default:
      return detail ? `Błąd OpenRouter (${status}): ${detail}` : `Błąd OpenRouter (${status}).`
  }
}

/** Aborts when the caller aborts or when nothing happens for `ms`; `touch()` restarts the clock. */
class Deadline {
  readonly signal: AbortSignal
  private readonly timeout = new AbortController()
  private readonly ms: number
  private readonly caller?: AbortSignal
  private timer: NodeJS.Timeout

  // Plain fields rather than parameter properties: scripts/test-tools.ts loads this file with
  // Node's type stripping, which doesn't support them.
  constructor(ms: number, caller?: AbortSignal) {
    this.ms = ms
    this.caller = caller
    this.signal = caller ? AbortSignal.any([caller, this.timeout.signal]) : this.timeout.signal
    this.timer = setTimeout(() => this.timeout.abort(), ms)
  }

  touch(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.timeout.abort(), this.ms)
  }

  clear(): void {
    clearTimeout(this.timer)
  }

  /** The caller's own abort passes through untouched; everything else becomes a readable error. */
  explain(error: unknown, otherwise: string): unknown {
    if (this.caller?.aborted) return error
    return new OpenRouterError(this.timeout.signal.aborted ? TIMEOUT_MESSAGE : otherwise)
  }
}

async function request(path: string, apiKey: string, init: RequestInit, deadline: Deadline): Promise<Response> {
  let response: Response
  try {
    response = await fetch(BASE_URL + path, {
      ...init,
      signal: deadline.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      }
    })
  } catch (error) {
    throw deadline.explain(error, 'Brak połączenia z OpenRouter. Sprawdź internet.')
  }
  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: { message?: string } }
      detail = body.error?.message ?? ''
    } catch {
      // Body was not JSON; the status alone is descriptive enough.
    }
    throw new OpenRouterError(describeStatus(response.status, detail), response.status)
  }
  return response
}

async function readJson<T>(response: Response, deadline: Deadline): Promise<T> {
  try {
    return (await response.json()) as T
  } catch (error) {
    throw deadline.explain(error, CONNECTION_LOST_MESSAGE)
  }
}

export async function checkKey(apiKey: string): Promise<KeyInfo> {
  const deadline = new Deadline(KEY_CHECK_TIMEOUT_MS)
  try {
    const response = await request('/key', apiKey, { method: 'GET' }, deadline)
    const body = await readJson<{
      data?: { label?: string; limit_remaining?: unknown; usage?: unknown; usage_daily?: unknown }
    }>(response, deadline)
    return {
      label: body.data?.label ?? null,
      limitRemaining: numberOrNull(body.data?.limit_remaining),
      usage: numberOrNull(body.data?.usage),
      usageDaily: numberOrNull(body.data?.usage_daily)
    }
  } finally {
    deadline.clear()
  }
}

export async function transcribe(options: {
  apiKey: string
  model: string
  audio: Buffer
  format: string
  language: string | null
  signal?: AbortSignal
}): Promise<Transcription> {
  const body = {
    model: options.model,
    input_audio: { data: options.audio.toString('base64'), format: options.format },
    temperature: 0,
    ...(options.language ? { language: options.language } : {})
  }
  const deadline = new Deadline(TRANSCRIPTION_TIMEOUT_MS, options.signal)
  try {
    const response = await request(
      '/audio/transcriptions',
      options.apiKey,
      { method: 'POST', body: JSON.stringify(body) },
      deadline
    )
    const result = await readJson<{ text?: string; usage?: unknown }>(response, deadline)
    return { text: (result.text ?? '').trim(), cost: costOf(result.usage), tokens: tokensOf(result.usage) }
  } finally {
    deadline.clear()
  }
}

/** The model can't call tools, so the tools have to go. */
function toolsUnsupported(error: unknown): boolean {
  return (
    error instanceof OpenRouterError &&
    (error.status === 400 || error.status === 404) &&
    /tool/i.test(error.message)
  )
}

interface ChatOptions {
  apiKey: string
  model: string
  messages: ChatMessage[]
  /** OpenRouter's server-side web search. */
  webSearch: boolean
  /** Functions the model may call; the calls come back in the result. */
  functions: FunctionTool[]
  /** 'none' makes the model answer in text even though the conversation already used tools. */
  toolChoice?: 'auto' | 'none'
  onDelta: (text: string) => void
  onSource: (source: Source) => void
  signal?: AbortSignal
}

/**
 * Streams a chat completion, calling `onDelta` with each text fragment as it arrives.
 * Models that can't use tools answer without web search and functions.
 */
export async function streamChat(options: ChatOptions): Promise<ChatResult> {
  const withTools = options.webSearch || options.functions.length > 0
  if (!withTools) return streamOnce(options, false)
  let answered = false
  try {
    return await streamOnce({ ...options, onDelta: (text) => ((answered = true), options.onDelta(text)) }, true)
  } catch (error) {
    if (answered || !toolsUnsupported(error)) throw error
    return streamOnce(options, false)
  }
}

async function streamOnce(options: ChatOptions, withTools: boolean): Promise<ChatResult> {
  const deadline = new Deadline(STREAM_IDLE_TIMEOUT_MS, options.signal)
  const result: ChatResult = { text: '', cost: null, tokens: null, toolCalls: [], reasoningDetails: [] }
  // Tool calls stream in pieces, keyed by index.
  const calls = new Map<number, ToolCall>()
  const reasoning = new ReasoningCollector()
  const seen = new Set<string>()
  const addSources = (annotations: unknown): void => {
    if (!Array.isArray(annotations)) return
    for (const annotation of annotations) {
      const source = citation(annotation)
      if (!source || seen.has(source.url)) continue
      seen.add(source.url)
      options.onSource(source)
    }
  }
  const finish = (): ChatResult => {
    result.toolCalls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, call]) => ({ ...call, id: call.id || `call_${index}` }))
    result.reasoningDetails = reasoning.details()
    return result
  }
  const tools = withTools
    ? [
        ...(options.webSearch ? [{ type: 'openrouter:web_search' }] : []),
        ...options.functions.map((f) => ({ type: 'function', function: f }))
      ]
    : []
  try {
    const body = {
      model: options.model,
      messages: options.messages,
      stream: true,
      ...(tools.length > 0 ? { tools, ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}) } : {})
    }
    const response = await request(
      '/chat/completions',
      options.apiKey,
      { method: 'POST', body: JSON.stringify(body) },
      deadline
    )
    if (!response.body) throw new OpenRouterError('OpenRouter zwrócił pustą odpowiedź.')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      let read: Awaited<ReturnType<typeof reader.read>>
      try {
        read = await reader.read()
      } catch (error) {
        throw deadline.explain(error, CONNECTION_LOST_MESSAGE)
      }
      if (read.done) return finish()
      deadline.touch()
      buffer += decoder.decode(read.value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        // Lines starting with ':' are keep-alive comments (": OPENROUTER PROCESSING").
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return finish()

        let event: {
          error?: { message?: string; code?: number }
          choices?: {
            delta?: {
              content?: string | null
              annotations?: unknown
              reasoning_details?: unknown
              tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[]
            }
            message?: { annotations?: unknown }
          }[]
          usage?: unknown
        }
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        if (event.error) {
          throw new OpenRouterError(event.error.message ?? 'Model przerwał odpowiedź z błędem.', event.error.code)
        }
        // Usage, with the cost, arrives in the last chunk.
        result.cost = costOf(event.usage) ?? result.cost
        result.tokens = tokensOf(event.usage) ?? result.tokens
        const choice = event.choices?.[0]
        addSources(choice?.delta?.annotations)
        addSources(choice?.message?.annotations)
        reasoning.add(choice?.delta?.reasoning_details)
        for (const part of choice?.delta?.tool_calls ?? []) {
          const index = part.index ?? 0
          const call = calls.get(index) ?? { id: '', name: '', arguments: '' }
          call.id ||= part.id ?? ''
          call.name += part.function?.name ?? ''
          call.arguments += part.function?.arguments ?? ''
          calls.set(index, call)
        }
        const delta = choice?.delta?.content
        if (delta) {
          result.text += delta
          options.onDelta(delta)
        }
      }
    }
  } finally {
    deadline.clear()
  }
}

/** Text-like fields arrive in fragments; every other field is complete in whichever chunk carries it. */
const STREAMED_FIELDS = new Set(['text', 'summary', 'data'])

/**
 * Rebuilds the reasoning blocks from their streamed fragments, in the order they started.
 * Fragments of one block share its `index` (and type; a Gemini thought signature can share
 * the index of a text block).
 */
export class ReasoningCollector {
  private readonly blocks = new Map<string, ReasoningDetail>()
  private readonly lastKeyOfIndex = new Map<number, string>()
  private unindexed = 0

  add(fragments: unknown): void {
    if (!Array.isArray(fragments)) return
    for (const fragment of fragments) {
      if (!fragment || typeof fragment !== 'object') continue
      const part = fragment as ReasoningDetail
      const index = typeof part.index === 'number' ? part.index : null
      const key =
        index === null
          ? `#${this.unindexed++}`
          : typeof part.type === 'string'
            ? `${part.type}|${index}`
            : (this.lastKeyOfIndex.get(index) ?? `?|${index}`)
      if (index !== null) this.lastKeyOfIndex.set(index, key)
      const block = this.blocks.get(key)
      if (!block) {
        this.blocks.set(key, { ...part })
        continue
      }
      for (const [field, value] of Object.entries(part)) {
        if (STREAMED_FIELDS.has(field) && typeof value === 'string') {
          block[field] = (typeof block[field] === 'string' ? block[field] : '') + value
        } else if (value !== null && value !== undefined && value !== '') {
          block[field] = value
        }
      }
    }
  }

  details(): ReasoningDetail[] {
    return [...this.blocks.values()]
  }
}

/** Generates (or, with references, edits) a picture through OpenRouter's Image API. */
export async function generateImage(options: {
  apiKey: string
  model: string
  prompt: string
  aspectRatio: string | null
  /** Data URLs of pictures to work from. */
  references: string[]
  signal?: AbortSignal
}): Promise<ImageResult> {
  const body = {
    model: options.model,
    prompt: options.prompt,
    ...(options.aspectRatio ? { aspect_ratio: options.aspectRatio } : {}),
    ...(options.references.length > 0
      ? { input_references: options.references.map((url) => ({ type: 'image_url', image_url: { url } })) }
      : {})
  }
  const deadline = new Deadline(IMAGE_TIMEOUT_MS, options.signal)
  try {
    const response = await request('/images', options.apiKey, { method: 'POST', body: JSON.stringify(body) }, deadline)
    const result = await readJson<{ data?: { b64_json?: string; media_type?: string }[]; usage?: unknown }>(
      response,
      deadline
    )
    const images = (result.data ?? [])
      .filter((item) => typeof item.b64_json === 'string' && item.b64_json.length > 0)
      .map((item) => ({ data: Buffer.from(item.b64_json as string, 'base64'), mimeType: item.media_type ?? 'image/png' }))
    if (images.length === 0) throw new OpenRouterError('Model obrazów nie zwrócił obrazu. Spróbuj opisać go inaczej.')
    return { images, cost: costOf(result.usage), tokens: tokensOf(result.usage) }
  } finally {
    deadline.clear()
  }
}
