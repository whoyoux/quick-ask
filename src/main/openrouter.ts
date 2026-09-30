// Minimal OpenRouter client: speech-to-text and streamed chat completions.

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
  limitRemaining: number | null
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
    const body = await readJson<{ data?: { label?: string; limit_remaining?: number | null } }>(response, deadline)
    return { label: body.data?.label ?? null, limitRemaining: body.data?.limit_remaining ?? null }
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
}): Promise<string> {
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
    const result = await readJson<{ text?: string }>(response, deadline)
    return (result.text ?? '').trim()
  } finally {
    deadline.clear()
  }
}

/** Streams a chat completion, calling `onDelta` with each text fragment as it arrives. */
export async function streamChat(options: {
  apiKey: string
  model: string
  messages: ChatMessage[]
  onDelta: (text: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const deadline = new Deadline(STREAM_IDLE_TIMEOUT_MS, options.signal)
  try {
    const response = await request(
      '/chat/completions',
      options.apiKey,
      { method: 'POST', body: JSON.stringify({ model: options.model, messages: options.messages, stream: true }) },
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
      if (read.done) return
      deadline.touch()
      buffer += decoder.decode(read.value, { stream: true })

      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        // Lines starting with ':' are keep-alive comments (": OPENROUTER PROCESSING").
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return

        let event: {
          error?: { message?: string; code?: number }
          choices?: { delta?: { content?: string | null } }[]
        }
        try {
          event = JSON.parse(data)
        } catch {
          continue
        }
        if (event.error) {
          throw new OpenRouterError(event.error.message ?? 'Model przerwał odpowiedź z błędem.', event.error.code)
        }
        const delta = event.choices?.[0]?.delta?.content
        if (delta) options.onDelta(delta)
      }
    }
  } finally {
    deadline.clear()
  }
}
