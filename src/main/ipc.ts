import { clipboard, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  MAX_ATTACHMENTS,
  type DroppedFile,
  type ExternalLink,
  type HistoryList,
  type KeyCheckResult,
  type Microphone,
  type RecordingOutcome,
  type SetupStatus
} from '../shared/types'
import type { Controller } from './controller'
import type { HistoryStore } from './db/history'
import {
  copyImageToClipboard,
  deleteImages,
  importClipboardImages,
  importImageBytes,
  isImageName,
  openImage,
  pickImageFiles,
  saveImageAs
} from './images'
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
  onMicrophones(microphones: Microphone[]): void
}

function isMicrophone(value: unknown): value is Microphone {
  const mic = value as Partial<Microphone> | null
  return typeof mic?.deviceId === 'string' && typeof mic.label === 'string'
}

function isDroppedFile(value: unknown): value is DroppedFile {
  const file = value as Partial<DroppedFile> | null
  return typeof file?.name === 'string' && typeof file.type === 'string' && file.data instanceof ArrayBuffer
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
  onKeyChanged,
  onMicrophones
}: IpcDeps): void {
  const fromOverlay = (event: IpcMainEvent): boolean => event.sender === overlay.webContents
  const fromSettings = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isSettingsWindow(event.sender)
  const fromHistory = (event: IpcMainEvent | IpcMainInvokeEvent): boolean => isHistoryWindow(event.sender)

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
    if (fromOverlay(event) && typeof text === 'string') void clipboard.writeText(text)
  })
  ipcMain.on('overlay:attach-clipboard', (event) => {
    if (fromOverlay(event)) void controller.attach((room) => importClipboardImages(room))
  })
  ipcMain.on('overlay:attach-files', (event) => {
    if (fromOverlay(event)) void controller.attach(() => pickImageFiles(MAX_ATTACHMENTS))
  })
  ipcMain.on('overlay:attach-dropped', (event, files: unknown) => {
    if (!fromOverlay(event) || !Array.isArray(files)) return
    const dropped = files.filter(isDroppedFile).slice(0, MAX_ATTACHMENTS)
    if (dropped.length === 0) return
    void controller.attach(() => dropped.map((file) => importImageBytes(Buffer.from(file.data), file.type)))
  })
  ipcMain.on('overlay:remove-attachment', (event, name: unknown) => {
    if (fromOverlay(event) && isImageName(name)) controller.removeAttachment(name)
  })
  // Picture actions report failures in the panel instead of failing silently.
  const imageAction = (channel: string, action: (name: string) => Promise<void>): void => {
    ipcMain.on(channel, (event, name: unknown) => {
      if (!fromOverlay(event) || !isImageName(name)) return
      action(name).catch((error: unknown) =>
        controller.notify(error instanceof Error ? error.message : String(error))
      )
    })
  }
  imageAction('overlay:copy-image', copyImageToClipboard)
  imageAction('overlay:save-image', saveImageAs)
  imageAction('overlay:open-image', openImage)
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
    deleteImages(history.delete(valid))
    controller.conversationDeleted(valid)
  })
  ipcMain.handle('history:clear', (event) => {
    if (!fromHistory(event)) throw new Error('forbidden')
    deleteImages(history?.clear() ?? [])
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
