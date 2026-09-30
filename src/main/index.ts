import { app, session, systemPreferences, type WebContents } from 'electron'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_ATTACHMENTS, type SetupStatus } from '../shared/types'
import { Controller } from './controller'
import { HistoryStore } from './db/history'
import { notifyHistoryWindow, openHistoryWindow } from './history-window'
import { handleImageProtocol, importClipboardImages, pickImageFiles, registerImageScheme, sweepImages } from './images'
import { maskedKey, registerIpc } from './ipc'
import { checkKey } from './openrouter'
import { ChatWindow } from './chat-window'
import { OverlayWindow } from './overlay-window'
import { Surfaces } from './surfaces'
import { PTT_KEYS, PushToTalk } from './push-to-talk'
import { getApiKey } from './secrets'
import { settings } from './settings'
import { openSettingsWindow } from './settings-window'
import { TrayMenu } from './tray'

const isMac = process.platform === 'darwin'
/** OpenRouter books a request's cost a moment after the response ends. */
const BALANCE_DELAY_MS = 3000

/** The conversation history; without it the app still answers questions, it just can't save them. */
function openHistory(): HistoryStore | null {
  try {
    const dir = app.getPath('userData')
    mkdirSync(dir, { recursive: true })
    // Migrations ship next to package.json: the project root in dev, app.asar when packaged.
    return new HistoryStore(join(dir, 'history.db'), join(app.getAppPath(), 'drizzle'))
  } catch (error) {
    console.error('[quick-ask] history database unavailable:', error)
    return null
  }
}

/**
 * Only the pill (which records) may use the microphone, audio only. It and the chat window may
 * write to the clipboard, which the "Kopiuj kod" buttons on code blocks use.
 */
function grantPermissions(recorder: WebContents, chat: WebContents): void {
  const allowed = (requester: WebContents | null, permission: string, audioOnly: boolean): boolean =>
    (requester === recorder && permission === 'media' && audioOnly) ||
    ((requester === recorder || requester === chat) && permission === 'clipboard-sanitized-write')
  session.defaultSession.setPermissionRequestHandler((requester, permission, callback, details) => {
    const audioOnly = 'mediaTypes' in details && (details.mediaTypes ?? []).every((t) => t === 'audio')
    callback(allowed(requester, permission, audioOnly))
  })
  session.defaultSession.setPermissionCheckHandler((requester, permission) =>
    allowed(requester, permission, true)
  )
}

function main(): void {
  const overlay = new OverlayWindow({
    saved: () => settings.get().overlayPosition,
    userMoved: (position) => settings.update({ overlayPosition: position })
  })
  const chat = new ChatWindow({
    saved: () => settings.get().chatBounds,
    save: (bounds) => settings.update({ chatBounds: bounds })
  })
  grantPermissions(overlay.webContents, chat.webContents)
  const surfaces = new Surfaces(overlay, chat)

  let tray: TrayMenu | null = null
  let accessibilityPoll: NodeJS.Timeout | null = null

  const pttLabel = (): string => PTT_KEYS[settings.get().pttKey].label
  const history = openHistory()
  handleImageProtocol()
  // Pictures of unsaved conversations and never-sent attachments from earlier runs.
  sweepImages(new Set(history?.imageFiles() ?? []))

  const controller = new Controller(
    surfaces,
    {
      onRecordingChange: (recording) => tray?.setRecording(recording),
      onConversationChange: () => tray?.rebuild(),
      onHistoryChange: notifyHistoryWindow,
      onSpend: () => refreshBalanceSoon(),
      openSettings: openSettingsWindow,
      hint: (followUp) => {
        const goal = followUp ? 'dopytać' : 'zadać pytanie'
        return ptt.isRunning
          ? `Przytrzymaj ${pttLabel()}, aby ${goal}`
          : `Kliknij ikonę Quick Ask w zasobniku, aby ${goal}`
      }
    },
    history
  )

  const ptt = new PushToTalk({
    onPress: () => controller.keyPressed(),
    onHold: () => controller.keyHeld(),
    onRelease: () => controller.keyReleased(),
    onCancel: () => controller.keyCancelled(),
    onEscape: () => controller.escape()
  })
  ptt.setKey(settings.get().pttKey)

  // Spending shown in the tray, from GET /key. A failed check keeps the last known numbers.
  let balanceRequest = 0
  let balanceTimer: NodeJS.Timeout | null = null
  const refreshBalance = (): void => {
    const key = getApiKey()
    const request = ++balanceRequest
    if (!key) {
      tray?.setBalance(null)
      return
    }
    checkKey(key).then(
      (info) => request === balanceRequest && tray?.setBalance(info),
      (error) => console.warn('[quick-ask] could not refresh the balance:', error)
    )
  }
  const refreshBalanceSoon = (): void => {
    if (balanceTimer) clearTimeout(balanceTimer)
    balanceTimer = setTimeout(() => {
      balanceTimer = null
      refreshBalance()
    }, BALANCE_DELAY_MS)
  }

  const refresh = (): void => {
    tray?.rebuild()
    controller.refresh()
  }

  const startHookWhenTrusted = (): void => {
    if (accessibilityPoll) return
    accessibilityPoll = setInterval(() => {
      if (!systemPreferences.isTrustedAccessibilityClient(false)) return
      if (accessibilityPoll) clearInterval(accessibilityPoll)
      accessibilityPoll = null
      ptt.start()
      refresh()
    }, 2000)
  }

  const requestAccessibility = (): void => {
    if (!isMac) return
    // Shows the system prompt that leads to Privacy & Security → Accessibility.
    systemPreferences.isTrustedAccessibilityClient(true)
    startHookWhenTrusted()
  }

  const setupStatus = (): SetupStatus => ({
    platform: process.platform,
    hasKey: getApiKey() !== null,
    maskedKey: maskedKey(),
    needsAccessibility: isMac && !ptt.isRunning,
    pttLabel: pttLabel()
  })

  tray = new TrayMenu(
    {
      toggleHandsFree: () => controller.toggleHandsFree(),
      startTyping: () => controller.startTyping(),
      attachClipboard: () => void controller.attach((room) => importClipboardImages(room)),
      attachFiles: () => void controller.attach(() => pickImageFiles(MAX_ATTACHMENTS)),
      showLastConversation: () => controller.showLastConversation(),
      openHistory: openHistoryWindow,
      openSettings: openSettingsWindow,
      requestAccessibility
    },
    () => ({
      hasKey: getApiKey() !== null,
      hookRunning: ptt.isRunning,
      recording: controller.isRecording,
      hasConversation: controller.hasConversation
    })
  )

  chat.onClose = () => controller.hide()

  registerIpc({
    overlay,
    chat,
    controller,
    history,
    setupStatus,
    requestAccessibility,
    onKeyChanged: () => {
      refresh()
      refreshBalance()
    },
    onMicrophones: (microphones) => tray?.setMicrophones(microphones)
  })

  // Global key listening needs the Accessibility permission on macOS.
  if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) requestAccessibility()
  else ptt.start()
  refresh()
  refreshBalance()

  let previous = settings.get()
  settings.onChange((current) => {
    if (current.pttKey !== previous.pttKey) ptt.setKey(current.pttKey)
    if (previous.overlayPosition && !current.overlayPosition) overlay.resetPosition()
    if (current.saveHistory !== previous.saveHistory) notifyHistoryWindow()
    previous = current
    refresh()
  })

  // `quick-ask --toggle` starts/stops a hands-free question. On Linux Wayland, where apps
  // can't listen to global keys, bind this command to a system shortcut instead.
  app.on('second-instance', (_event, argv) => {
    if (argv.includes('--toggle')) controller.toggleHandsFree()
    else openSettingsWindow()
  })
  if (process.argv.includes('--toggle')) {
    overlay.webContents.once('did-finish-load', () => controller.toggleHandsFree())
  }

  app.on('will-quit', () => {
    ptt.stop()
    history?.close()
  })

  if (!getApiKey()) openSettingsWindow()
}

// The overlay shows pictures through qa-image:; schemes must be registered before the app is ready.
registerImageScheme()

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // Quick Ask lives in the tray: closing the settings window must not quit the app.
  app.on('window-all-closed', () => {})
  void app.whenReady().then(() => {
    if (isMac) app.dock?.hide()
    if (process.platform === 'win32') app.setAppUserModelId('com.whoyoux.quickask')
    main()
  })
}
