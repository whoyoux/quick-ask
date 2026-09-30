import { clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { ExternalLink, KeyCheckResult, Microphone, RecordingOutcome, SetupStatus } from '../shared/types'
import type { Controller } from './controller'
import { checkKey, OpenRouterError } from './openrouter'
import type { OverlayWindow } from './overlay-window'
import { clearApiKey, getApiKey, maskKey, setApiKey } from './secrets'
import { closeSettingsWindow, isSettingsWindow } from './settings-window'

const LINKS: Record<ExternalLink, string> = {
  keys: 'https://openrouter.ai/keys',
  credits: 'https://openrouter.ai/settings/credits'
}

export interface IpcDeps {
  overlay: OverlayWindow
  controller: Controller
  setupStatus(): SetupStatus
  requestAccessibility(): void
  onKeyChanged(): void
  onMicrophones(microphones: Microphone[]): void
}

function isMicrophone(value: unknown): value is Microphone {
  const mic = value as Partial<Microphone> | null
  return typeof mic?.deviceId === 'string' && typeof mic.label === 'string'
}

export function registerIpc({
  overlay,
  controller,
  setupStatus,
  requestAccessibility,
  onKeyChanged,
  onMicrophones
}: IpcDeps): void {
  const fromOverlay = (event: IpcMainEvent): boolean => event.sender === overlay.webContents
  const fromSettings = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isSettingsWindow(event.sender)

  // Overlay --------------------------------------------------------------------------------
  ipcMain.on('overlay:recording', (event, outcome: RecordingOutcome) => {
    if (fromOverlay(event)) controller.handleRecording(outcome)
  })
  ipcMain.on('overlay:microphones', (event, microphones: unknown) => {
    if (fromOverlay(event) && Array.isArray(microphones)) onMicrophones(microphones.filter(isMicrophone))
  })
  ipcMain.on('overlay:resize', (event, size: { width: number; height: number }) => {
    if (fromOverlay(event) && Number.isFinite(size?.width) && Number.isFinite(size?.height)) overlay.resize(size)
  })
  ipcMain.on('overlay:close', (event) => {
    if (fromOverlay(event)) controller.hide()
  })
  ipcMain.on('overlay:new-conversation', (event) => {
    if (fromOverlay(event)) controller.newConversation()
  })
  ipcMain.on('overlay:copy', (event, text: unknown) => {
    if (fromOverlay(event) && typeof text === 'string') clipboard.writeText(text)
  })
  ipcMain.on('overlay:send-now', (event) => {
    if (fromOverlay(event)) controller.sendNow()
  })
  ipcMain.on('overlay:cancel-recording', (event) => {
    if (fromOverlay(event)) controller.cancelFromUi()
  })

  // Settings window ------------------------------------------------------------------------
  ipcMain.handle('settings:status', (event) => {
    if (!fromSettings(event)) throw new Error('forbidden')
    return setupStatus()
  })
  ipcMain.handle('settings:save-key', async (event, rawKey: unknown): Promise<KeyCheckResult> => {
    if (!fromSettings(event)) throw new Error('forbidden')
    const key = typeof rawKey === 'string' ? rawKey.trim() : ''
    if (!key) return { ok: false, message: 'Wklej klucz API.' }
    try {
      const info = await checkKey(key)
      setApiKey(key)
      onKeyChanged()
      const credit =
        info.limitRemaining !== null ? ` Pozostały limit klucza: $${info.limitRemaining.toFixed(2)}.` : ''
      return { ok: true, message: `Klucz działa i jest zapisany.${credit}` }
    } catch (error) {
      const message =
        error instanceof OpenRouterError && error.status === 401
          ? 'OpenRouter nie rozpoznał tego klucza. Sprawdź, czy skopiowałeś go w całości.'
          : error instanceof Error
            ? error.message
            : String(error)
      return { ok: false, message }
    }
  })
  ipcMain.handle('settings:remove-key', (event) => {
    if (!fromSettings(event)) throw new Error('forbidden')
    clearApiKey()
    onKeyChanged()
  })
  ipcMain.handle('settings:request-accessibility', (event) => {
    if (!fromSettings(event)) throw new Error('forbidden')
    requestAccessibility()
  })
  ipcMain.on('settings:open-link', (event, link: ExternalLink) => {
    if (fromSettings(event) && link in LINKS) void shell.openExternal(LINKS[link])
  })
  ipcMain.on('settings:close', (event) => {
    if (fromSettings(event)) closeSettingsWindow()
  })
}

export function maskedKey(): string | null {
  const key = getApiKey()
  return key ? maskKey(key) : null
}
