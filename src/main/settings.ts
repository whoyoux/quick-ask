import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
  /** Save finished questions and answers to the local history database. */
  saveHistory: boolean
}

function defaults(): Settings {
  const systemLanguage = app.getPreferredSystemLanguages()[0] ?? ''
  return {
    chatModel: 'google/gemini-3.8-flash',
    transcriptionModel: 'openai/whisper-large-v3-turbo',
    // Auto-detection misfires on short utterances, so pin Polish for Polish systems.
    language: systemLanguage.startsWith('pl') ? 'pl' : 'auto',
    answerLength: 'normal',
    pttKey: process.platform === 'darwin' ? 'alt-right' : 'ctrl-right',
    overlayPosition: null,
    saveHistory: true
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
      return { ...defaults(), ...stored }
    } catch {
      return defaults()
    }
  }
}

export const settings = new SettingsStore()
