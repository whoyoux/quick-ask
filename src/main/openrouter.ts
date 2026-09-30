// Minimal OpenRouter client: speech-to-text and streamed chat completions.

// Overridable for testing against a local mock server.
const BASE_URL = process.env.QUICK_ASK_API_BASE ?? 'https://openrouter.ai/api/v1'

// Optional attribution headers, see https://openrouter.ai/docs/app-attribution
const APP_HEADERS = {
  'HTTP-Referer': 'https://github.com/whoyoux/quick-ask',
  'X-Title': 'Quick Ask'
}

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

async function request(path: string, apiKey: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let response: Response
  try {
    response = await fetch(BASE_URL + path, {
      ...init,
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...APP_HEADERS
      }
    })
  } catch (error) {
    if (signal?.aborted) throw error
    throw new OpenRouterError('Brak połączenia z OpenRouter. Sprawdź internet.')
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

export async function checkKey(apiKey: string): Promise<KeyInfo> {
  const response = await request('/key', apiKey, { method: 'GET' })
  const body = (await response.json()) as { data?: { label?: string; limit_remaining?: number | null } }
  return { label: body.data?.label ?? null, limitRemaining: body.data?.limit_remaining ?? null }
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
  const response = await request(
    '/audio/transcriptions',
    options.apiKey,
    { method: 'POST', body: JSON.stringify(body) },
    options.signal
  )
  const result = (await response.json()) as { text?: string }
  return (result.text ?? '').trim()
}

/** Streams a chat completion, calling `onDelta` with each text fragment as it arrives. */
export async function streamChat(options: {
  apiKey: string
  model: string
  messages: ChatMessage[]
  onDelta: (text: string) => void
  signal?: AbortSignal
}): Promise<void> {
  const response = await request(
    '/chat/completions',
    options.apiKey,
    { method: 'POST', body: JSON.stringify({ model: options.model, messages: options.messages, stream: true }) },
    options.signal
  )
  if (!response.body) throw new OpenRouterError('OpenRouter zwrócił pustą odpowiedź.')

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return
    buffer += decoder.decode(value, { stream: true })

    let newline: number
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      // Lines starting with ':' are keep-alive comments (": OPENROUTER PROCESSING").
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return

      let chunk: {
        error?: { message?: string; code?: number }
        choices?: { delta?: { content?: string | null } }[]
      }
      try {
        chunk = JSON.parse(data)
      } catch {
        continue
      }
      if (chunk.error) {
        throw new OpenRouterError(chunk.error.message ?? 'Model przerwał odpowiedź z błędem.', chunk.error.code)
      }
      const delta = chunk.choices?.[0]?.delta?.content
      if (delta) options.onDelta(delta)
    }
  }
}
