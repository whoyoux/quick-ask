// Models offered in the tray menu. IDs are OpenRouter slugs (GET /api/v1/models).

export interface ModelOption {
  id: string
  /** Short name, also shown next to timings under each answer. */
  name: string
  /** Menu label. */
  label: string
  /** Listed first, under "Polecane". */
  recommended?: boolean
}

export const CHAT_MODELS: ModelOption[] = [
  {
    id: 'google/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    label: 'Gemini 3.8 Flash (szybki)',
    recommended: true
  },
  {
    // An OpenRouter alias that always points at the newest Gemini Pro.
    id: '~google/gemini-pro-latest',
    name: 'Gemini Pro',
    label: 'Gemini Pro (myślący, wolniejszy)',
    recommended: true
  },
  { id: 'anthropic/claude-haiku-4.5', name: 'Claude Haiku 4.5', label: 'Claude Haiku 4.5 (szybki)' },
  { id: 'openai/gpt-5.4-mini', name: 'GPT-5.4 mini', label: 'GPT-5.4 mini (szybki)' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5', label: 'Claude Sonnet 5.5' },
  { id: 'openai/gpt-5.5', name: 'GPT-5.5', label: 'GPT-5.5' }
]

export const TRANSCRIPTION_MODELS: ModelOption[] = [
  { id: 'x-ai/grok-stt-1.0', name: 'Grok STT', label: 'Grok STT (xAI)', recommended: true },
  { id: 'openai/whisper-large-v3-turbo', name: 'Whisper Turbo', label: 'Whisper Large v3 Turbo (tani)' },
  { id: 'deepgram/nova-3', name: 'Deepgram Nova-3', label: 'Deepgram Nova-3' },
  { id: 'openai/gpt-4o-mini-transcribe', name: 'GPT-4o mini Transcribe', label: 'GPT-4o mini Transcribe' },
  { id: 'openai/gpt-4o-transcribe', name: 'GPT-4o Transcribe', label: 'GPT-4o Transcribe (dokładny)' },
  { id: 'mistralai/voxtral-mini-transcribe', name: 'Voxtral Mini', label: 'Voxtral Mini Transcribe' }
]

export const DEFAULT_CHAT_MODEL = 'google/gemini-3.8-flash'
export const DEFAULT_TRANSCRIPTION_MODEL = 'x-ai/grok-stt-1.0'

/** Gemini 3.1 Pro used to be listed by its own slug; the alias replaces it. */
export const RENAMED_MODELS: Record<string, string> = {
  'google/gemini-3.1-pro-preview': '~google/gemini-pro-latest'
}

export function modelName(id: string): string {
  return [...CHAT_MODELS, ...TRANSCRIPTION_MODELS].find((m) => m.id === id)?.name ?? id.split('/').pop() ?? id
}
