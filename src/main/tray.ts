import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions, type NativeImage } from 'electron'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { CHAT_MODELS, TRANSCRIPTION_MODELS } from './models'
import { PTT_KEYS, type PttKeyId } from './push-to-talk'
import { settings, type AnswerLength, type Language } from './settings'

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
  openSettings(): void
  requestAccessibility(): void
}

export class TrayMenu {
  private readonly tray: Tray
  private readonly icons = { idle: loadIcon(false), recording: loadIcon(true) }
  private recording = false

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

    const chatModels = CHAT_MODELS.some((m) => m.id === current.chatModel)
      ? CHAT_MODELS
      : [{ id: current.chatModel, name: current.chatModel, label: current.chatModel }, ...CHAT_MODELS]

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
      { type: 'separator' },
      {
        label: 'Model odpowiedzi',
        submenu: chatModels.map((m) => ({
          label: m.label,
          type: 'radio',
          checked: current.chatModel === m.id,
          click: () => settings.update({ chatModel: m.id })
        }))
      },
      {
        label: 'Model transkrypcji',
        submenu: TRANSCRIPTION_MODELS.map((m) => ({
          label: m.label,
          type: 'radio',
          checked: current.transcriptionModel === m.id,
          click: () => settings.update({ transcriptionModel: m.id })
        }))
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
