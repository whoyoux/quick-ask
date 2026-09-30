import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_CHAT_MODEL, DEFAULT_IMAGE_MODEL, DEFAULT_TRANSCRIPTION_MODEL, RENAMED_MODELS } from './models'
import type { PttKeyId } from './push-to-talk'

export type Language = 'auto' | 'pl' | 'en'
export type AnswerLength = 'short' | 'normal' | 'detailed'

/** Where the user dragged the overlay: the top-center point of the window, in screen DIPs. */
export interface OverlayPosition {
  x: number
  y: number
}

export interface Settings {
  chatModel: string
  transcriptionModel: string
  language: Language
  answerLength: AnswerLength
  pttKey: PttKeyId
  /** null = default spot, top-center of the screen with the mouse cursor. */
  overlayPosition: OverlayPosition | null
  /** null = system default. */
  micDeviceId: string | null
  /** Name of the chosen microphone, so the tray can still name it while it is unplugged. */
  micLabel: string | null
  /** Save finished questions and answers to the local history database. */
  saveHistory: boolean
  /** Let the model search the web (OpenRouter's server-side web search tool). */
  webSearch: boolean
  /** Draws the pictures the chat model asks for. */
  imageModel: string
}

function defaults(): Settings {
  const systemLanguage = app.getPreferredSystemLanguages()[0] ?? ''
  return {
    chatModel: DEFAULT_CHAT_MODEL,
    transcriptionModel: DEFAULT_TRANSCRIPTION_MODEL,
    // Auto-detection misfires on short utterances, so pin Polish for Polish systems.
    language: systemLanguage.startsWith('pl') ? 'pl' : 'auto',
    answerLength: 'normal',
    pttKey: process.platform === 'darwin' ? 'alt-right' : 'ctrl-right',
    overlayPosition: null,
    micDeviceId: null,
    micLabel: null,
    saveHistory: true,
    webSearch: true,
    imageModel: DEFAULT_IMAGE_MODEL
  }
}

type Listener = (settings: Settings) => void

class SettingsStore {
  private current: Settings | null = null
  private listeners: Listener[] = []

  private get file(): string {
    return join(app.getPath('userData'), 'settings.json')
  }

  get(): Settings {
    if (!this.current) this.current = this.load()
    return this.current
  }

  update(patch: Partial<Settings>): void {
    this.current = { ...this.get(), ...patch }
    mkdirSync(dirname(this.file), { recursive: true })
    writeFileSync(this.file, JSON.stringify(this.current, null, 2))
    for (const listener of this.listeners) listener(this.current)
  }

  onChange(listener: Listener): void {
    this.listeners.push(listener)
  }

  private load(): Settings {
    try {
      const stored = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Settings>
      const loaded = { ...defaults(), ...stored }
      loaded.chatModel = RENAMED_MODELS[loaded.chatModel] ?? loaded.chatModel
      return loaded
    } catch {
      return defaults()
    }
  }
}

export const settings = new SettingsStore()
