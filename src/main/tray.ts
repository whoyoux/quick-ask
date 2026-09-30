import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatUsd } from '../shared/format'
import type { Microphone } from '../shared/types'
import { CHAT_MODELS, TRANSCRIPTION_MODELS, type ModelOption } from './models'
import type { KeyInfo } from './openrouter'
import { PTT_KEYS, type PttKeyId } from './push-to-talk'
import { settings, type AnswerLength, type Language, type Settings } from './settings'

const LANGUAGES: { id: Language; label: string }[] = [
  { id: 'auto', label: 'Wykrywaj automatycznie' },
  { id: 'pl', label: 'Polski' },
  { id: 'en', label: 'English' }
]

const ANSWER_LENGTHS: { id: AnswerLength; label: string }[] = [
  { id: 'short', label: 'Krótko' },
  { id: 'normal', label: 'Normalnie' },
  { id: 'detailed', label: 'Szczegółowo' }
]

function pttKeyOptions(): { id: PttKeyId; label: string }[] {
  if (process.platform === 'darwin') {
    return [
      { id: 'alt-right', label: 'Prawy Option ⌥' },
      { id: 'meta-right', label: 'Prawy Command ⌘' },
      { id: 'ctrl-right', label: 'Prawy Control' },
      { id: 'shift-right', label: 'Prawy Shift' }
    ]
  }
  return [
    { id: 'ctrl-right', label: 'Prawy Ctrl' },
    { id: 'shift-right', label: 'Prawy Shift' },
    // Right Alt is AltGr on Polish and many other layouts, so it collides with typing.
    { id: 'alt-right', label: 'Prawy Alt (koliduje z AltGr i polskimi znakami)' }
  ]
}

/** Recommended models first, under a heading; a model set by hand in settings.json stays visible. */
function modelItems(models: ModelOption[], currentId: string, choose: (id: string) => void): MenuItemConstructorOptions[] {
  const item = (m: ModelOption): MenuItemConstructorOptions => ({
    label: m.label,
    type: 'radio',
    checked: currentId === m.id,
    click: () => choose(m.id)
  })
  const custom: MenuItemConstructorOptions[] = models.some((m) => m.id === currentId)
    ? []
    : [{ label: currentId, type: 'radio', checked: true, enabled: false }, { type: 'separator' }]
  return [
    ...custom,
    { label: 'Polecane', enabled: false },
    ...models.filter((m) => m.recommended).map(item),
    { type: 'separator' },
    ...models.filter((m) => !m.recommended).map(item)
  ]
}

/** What OpenRouter tells a regular API key about money; the account balance needs a management key. */
function balanceItems(balance: KeyInfo | null): MenuItemConstructorOptions[] {
  if (!balance) return []
  const lines: string[] = []
  if (balance.limitRemaining !== null) lines.push(`Zostało na kluczu: ${formatUsd(balance.limitRemaining)}`)
  if (balance.usageDaily !== null && balance.usage !== null) {
    lines.push(`Wydane: ${formatUsd(balance.usageDaily)} dziś, ${formatUsd(balance.usage)} łącznie`)
  }
  return [
    ...lines.map((label): MenuItemConstructorOptions => ({ label, enabled: false })),
    { label: 'Doładuj kredyty OpenRouter…', click: () => void shell.openExternal('https://openrouter.ai/settings/credits') }
  ]
}

function microphoneItems(microphones: Microphone[], current: Settings): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    {
      label: 'Domyślny systemowy',
      type: 'radio',
      checked: current.micDeviceId === null,
      click: () => settings.update({ micDeviceId: null, micLabel: null })
    },
    ...microphones.map((mic, i): MenuItemConstructorOptions => {
      const label = mic.label || `Mikrofon ${i + 1}`
      return {
        label,
        type: 'radio',
        checked: current.micDeviceId === mic.deviceId,
        click: () => settings.update({ micDeviceId: mic.deviceId, micLabel: label })
      }
    })
  ]
  // An unplugged choice stays selected, so it comes back by itself once the device returns.
  if (current.micDeviceId !== null && !microphones.some((mic) => mic.deviceId === current.micDeviceId)) {
    items.push({
      label: `${current.micLabel ?? 'Wybrany mikrofon'} (niedostępny, nagrywam z domyślnego)`,
      type: 'radio',
      checked: true,
      enabled: false
    })
  }
  return items
}

function loadIcon(recording: boolean): NativeImage {
  const dir = join(app.getAppPath(), 'resources', 'tray')
  const image = nativeImage.createEmpty()
  if (process.platform === 'darwin') {
    const name = recording ? 'template-recording' : 'template'
    for (const [size, scaleFactor] of [[18, 1], [36, 2]] as const) {
      image.addRepresentation({ scaleFactor, buffer: readFileSync(join(dir, `${name}-${size}.png`)) })
    }
    // The idle icon follows the menu bar's light/dark tint; the recording one stays red.
    image.setTemplateImage(!recording)
    return image
  }
  const name = recording ? 'badge-recording' : 'badge'
  for (const [size, scaleFactor] of [[16, 1], [20, 1.25], [24, 1.5], [32, 2]] as const) {
    image.addRepresentation({ scaleFactor, buffer: readFileSync(join(dir, `${name}-${size}.png`)) })
  }
  return image
}

export interface TrayState {
  hasKey: boolean
  hookRunning: boolean
  recording: boolean
  hasConversation: boolean
}

export interface TrayActions {
  toggleHandsFree(): void
  showLastConversation(): void
  openHistory(): void
  openSettings(): void
  requestAccessibility(): void
}

export class TrayMenu {
  private readonly tray: Tray
  private readonly icons = { idle: loadIcon(false), recording: loadIcon(true) }
  private recording = false
  private microphones: Microphone[] = []
  private balance: KeyInfo | null = null

  constructor(
    private readonly actions: TrayActions,
    private readonly state: () => TrayState
  ) {
    this.tray = new Tray(this.icons.idle)
    this.tray.setToolTip('Quick Ask')
    // On Windows a left click would otherwise do nothing; show the same menu as right click.
    if (process.platform === 'win32') this.tray.on('click', () => this.tray.popUpContextMenu())
    this.rebuild()
  }

  setRecording(recording: boolean): void {
    if (recording === this.recording) return
    this.recording = recording
    this.tray.setImage(recording ? this.icons.recording : this.icons.idle)
    this.rebuild()
  }

  /** The overlay reports the list on load, on device changes and whenever a recording starts. */
  setMicrophones(microphones: Microphone[]): void {
    if (JSON.stringify(microphones) === JSON.stringify(this.microphones)) return
    this.microphones = microphones
    this.rebuild()
  }

  /** null hides the spending lines (no key, or OpenRouter couldn't be reached). */
  setBalance(balance: KeyInfo | null): void {
    this.balance = balance
    this.rebuild()
  }

  rebuild(): void {
    const state = this.state()
    const current = settings.get()
    const pttLabel = PTT_KEYS[current.pttKey].label

    const status: MenuItemConstructorOptions = !state.hasKey
      ? { label: 'Dodaj klucz API, aby zacząć…', click: () => this.actions.openSettings() }
      : !state.hookRunning
        ? process.platform === 'darwin'
          ? { label: 'Włącz dostęp do klawiatury…', click: () => this.actions.requestAccessibility() }
          : { label: 'Skrót klawiszowy niedostępny: użyj „Zadaj pytanie”', enabled: false }
        : { label: `Przytrzymaj ${pttLabel} i mów`, enabled: false }

    const template: MenuItemConstructorOptions[] = [
      status,
      {
        label: state.recording ? 'Wyślij pytanie' : 'Zadaj pytanie bez trzymania klawisza',
        enabled: state.hasKey,
        click: () => this.actions.toggleHandsFree()
      },
      {
        label: 'Wróć do ostatniej rozmowy',
        enabled: state.hasConversation,
        click: () => this.actions.showLastConversation()
      },
      { label: 'Historia rozmów…', click: () => this.actions.openHistory() },
      { type: 'separator' },
      ...(state.hasKey ? balanceItems(this.balance) : []),
      ...(state.hasKey && this.balance ? [{ type: 'separator' } as const] : []),
      {
        label: 'Model odpowiedzi',
        submenu: modelItems(CHAT_MODELS, current.chatModel, (id) => settings.update({ chatModel: id }))
      },
      {
        label: 'Model transkrypcji',
        submenu: modelItems(TRANSCRIPTION_MODELS, current.transcriptionModel, (id) =>
          settings.update({ transcriptionModel: id })
        )
      },
      {
        label: 'Język',
        submenu: LANGUAGES.map((l) => ({
          label: l.label,
          type: 'radio',
          checked: current.language === l.id,
          click: () => settings.update({ language: l.id })
        }))
      },
      {
        label: 'Długość odpowiedzi',
        submenu: ANSWER_LENGTHS.map((l) => ({
          label: l.label,
          type: 'radio',
          checked: current.answerLength === l.id,
          click: () => settings.update({ answerLength: l.id })
        }))
      },
      {
        label: 'Szukaj w internecie',
        type: 'checkbox',
        checked: current.webSearch,
        click: (item) => settings.update({ webSearch: item.checked })
      },
      { label: 'Mikrofon', submenu: microphoneItems(this.microphones, current) },
      {
        label: 'Klawisz nagrywania',
        submenu: pttKeyOptions().map((k) => ({
          label: k.label,
          type: 'radio',
          checked: current.pttKey === k.id,
          click: () => settings.update({ pttKey: k.id })
        }))
      },
      ...(current.overlayPosition
        ? [{ label: 'Przywróć położenie okna', click: () => settings.update({ overlayPosition: null }) }]
        : []),
      { type: 'separator' },
      { label: 'Klucz API OpenRouter…', click: () => this.actions.openSettings() },
      {
        label: 'Zapisuj historię rozmów',
        type: 'checkbox',
        checked: current.saveHistory,
        click: (item) => settings.update({ saveHistory: item.checked })
      },
      ...(process.platform === 'linux'
        ? []
        : [
            {
              label: 'Uruchamiaj przy starcie systemu',
              type: 'checkbox' as const,
              checked: app.getLoginItemSettings().openAtLogin,
              click: (item: Electron.MenuItem) => app.setLoginItemSettings({ openAtLogin: item.checked })
            }
          ]),
      { type: 'separator' },
      { label: 'Zakończ Quick Ask', click: () => app.quit() }
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }
}
