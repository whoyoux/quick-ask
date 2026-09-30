// Minimal OpenRouter client: speech-to-text and streamed chat completions.

import type { Source } from '../shared/types'

export type { Source }

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

export class OpenRouterError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'OpenRouterError'
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
  /** USD, from OpenRouter's usage accounting; null if the response didn't include it. */
  cost: number | null
}

export interface Transcription {
  text: string
  cost: number | null
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
  private timer: NodeJS.Timeout

  constructor(
    private readonly ms: number,
    private readonly caller?: AbortSignal
  ) {
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
    return { text: (result.text ?? '').trim(), cost: costOf(result.usage) }
  } finally {
    deadline.clear()
  }
}

/** The model can't call tools, so the web search tool has to go. */
function toolsUnsupported(error: unknown): boolean {
  return (
    error instanceof OpenRouterError &&
    (error.status === 400 || error.status === 404) &&
    /tool/i.test(error.message)
  )
}

/**
 * Streams a chat completion, calling `onDelta` with each text fragment as it arrives.
 * With `webSearch`, the model may search the web through OpenRouter's server-side tool;
 * models that can't use tools answer without it.
 */
export async function streamChat(options: {
  apiKey: string
  model: string
  messages: ChatMessage[]
  webSearch: boolean
  onDelta: (text: string) => void
  onSource: (source: Source) => void
  signal?: AbortSignal
}): Promise<ChatResult> {
  if (!options.webSearch) return streamOnce(options, false)
  let answered = false
  try {
    return await streamOnce({ ...options, onDelta: (text) => ((answered = true), options.onDelta(text)) }, true)
  } catch (error) {
    if (answered || !toolsUnsupported(error)) throw error
    return streamOnce(options, false)
  }
}

async function streamOnce(
  options: {
    apiKey: string
    model: string
    messages: ChatMessage[]
    onDelta: (text: string) => void
    onSource: (source: Source) => void
    signal?: AbortSignal
  },
  webSearch: boolean
): Promise<ChatResult> {
  const deadline = new Deadline(STREAM_IDLE_TIMEOUT_MS, options.signal)
  const result: ChatResult = { cost: null }
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
  try {
    const body = {
      model: options.model,
      messages: options.messages,
      stream: true,
      ...(webSearch ? { tools: [{ type: 'openrouter:web_search' }] } : {})
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
      if (read.done) return result
      deadline.touch()
      buffer += decoder.decode(read.value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        // Lines starting with ':' are keep-alive comments (": OPENROUTER PROCESSING").
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return result

        let event: {
          error?: { message?: string; code?: number }
          choices?: { delta?: { content?: string | null; annotations?: unknown }; message?: { annotations?: unknown } }[]
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
        const choice = event.choices?.[0]
        addSources(choice?.delta?.annotations)
        addSources(choice?.message?.annotations)
        const delta = choice?.delta?.content
        if (delta) options.onDelta(delta)
      }
    }
  } finally {
    deadline.clear()
  }
}
