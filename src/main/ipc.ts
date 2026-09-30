import { clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import type { ExternalLink, HistoryList, KeyCheckResult, RecordingOutcome, SetupStatus } from '../shared/types'
import type { Controller } from './controller'
import type { HistoryStore } from './db/history'
import { closeHistoryWindow, isHistoryWindow } from './history-window'
import { checkKey, OpenRouterError } from './openrouter'
import type { OverlayWindow } from './overlay-window'
import { clearApiKey, getApiKey, maskKey, setApiKey } from './secrets'
import { settings } from './settings'
import { closeSettingsWindow, isSettingsWindow } from './settings-window'

const LINKS: Record<ExternalLink, string> = {
  keys: 'https://openrouter.ai/keys',
  credits: 'https://openrouter.ai/settings/credits'
}

const MAX_QUERY_LENGTH = 200

export interface IpcDeps {
  overlay: OverlayWindow
  controller: Controller
  history: HistoryStore | null
  setupStatus(): SetupStatus
  requestAccessibility(): void
  onKeyChanged(): void
}

/** Conversation ids are UUIDs; anything else never matches a row. */
function conversationId(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f-]{36}$/i.test(value) ? value : null
}

export function registerIpc({
  overlay,
  controller,
  history,
  setupStatus,
  requestAccessibility,
  onKeyChanged
}: IpcDeps): void {
  const fromOverlay = (event: IpcMainEvent): boolean => event.sender === overlay.webContents
  const fromSettings = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isSettingsWindow(event.sender)
  const fromHistory = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isHistoryWindow(event.sender)

  // Overlay --------------------------------------------------------------------------------
  ipcMain.on('overlay:recording', (event, outcome: RecordingOutcome) => {
    if (fromOverlay(event)) controller.handleRecording(outcome)
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

  // History window -------------------------------------------------------------------------
  ipcMain.handle('history:list', (event, query: unknown): HistoryList => {
    if (!fromHistory(event)) throw new Error('forbidden')
    const text = typeof query === 'string' ? query.slice(0, MAX_QUERY_LENGTH) : ''
    return {
      available: history !== null,
      saving: settings.get().saveHistory,
      conversations: history?.list(text) ?? []
    }
  })
  ipcMain.handle('history:open', (event, id: unknown): boolean => {
    if (!fromHistory(event)) throw new Error('forbidden')
    const valid = conversationId(id)
    if (!valid || !controller.openConversation(valid)) return false
    closeHistoryWindow()
    return true
  })
  ipcMain.handle('history:delete', (event, id: unknown) => {
    if (!fromHistory(event)) throw new Error('forbidden')
    const valid = conversationId(id)
    if (!valid || !history) return
    history.delete(valid)
    controller.conversationDeleted(valid)
  })
  ipcMain.handle('history:clear', (event) => {
    if (!fromHistory(event)) throw new Error('forbidden')
    history?.clear()
    controller.conversationDeleted(null)
  })
  ipcMain.on('history:close', (event) => {
    if (fromHistory(event)) closeHistoryWindow()
  })
}

export function maskedKey(): string | null {
  const key = getApiKey()
  return key ? maskKey(key) : null
}
