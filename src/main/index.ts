import { app, session, systemPreferences, type WebContents } from 'electron'
import type { SetupStatus } from '../shared/types'
import { Controller } from './controller'
import { maskedKey, registerIpc } from './ipc'
import { OverlayWindow } from './overlay-window'
import { PTT_KEYS, PushToTalk } from './push-to-talk'
import { getApiKey } from './secrets'
import { settings } from './settings'
import { openSettingsWindow } from './settings-window'
import { TrayMenu } from './tray'

const isMac = process.platform === 'darwin'

/** Only the overlay may use the microphone, and only for audio. */
function allowMicrophoneFor(contents: WebContents): void {
  session.defaultSession.setPermissionRequestHandler((requester, permission, callback, details) => {
    const audioOnly =
      permission === 'media' && 'mediaTypes' in details && (details.mediaTypes ?? []).every((t) => t === 'audio')
    callback(requester === contents && audioOnly)
  })
  session.defaultSession.setPermissionCheckHandler(
    (requester, permission) => requester === contents && permission === 'media'
  )
}

function main(): void {
  const overlay = new OverlayWindow()
  allowMicrophoneFor(overlay.webContents)

  let tray: TrayMenu | null = null
  let accessibilityPoll: NodeJS.Timeout | null = null

  const pttLabel = (): string => PTT_KEYS[settings.get().pttKey].label

  const controller = new Controller(overlay, {
    onRecordingChange: (recording) => tray?.setRecording(recording),
    onConversationChange: () => tray?.rebuild(),
    openSettings: openSettingsWindow,
    hint: () =>
      ptt.isRunning
        ? `Przytrzymaj ${pttLabel()}, aby dopytać`
        : 'Kliknij ikonę Quick Ask w zasobniku, aby dopytać'
  })

  const ptt = new PushToTalk({
    onPress: () => controller.keyPressed(),
    onHold: () => controller.keyHeld(),
    onRelease: () => controller.keyReleased(),
    onCancel: () => controller.keyCancelled(),
    onEscape: () => controller.escape(),
    onMouseDown: () => controller.mouseDown()
  })
  ptt.setKey(settings.get().pttKey)

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
      showLastConversation: () => controller.showLastConversation(),
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

  registerIpc({ overlay, controller, setupStatus, requestAccessibility, onKeyChanged: refresh })

  // Global key listening needs the Accessibility permission on macOS.
  if (isMac && !systemPreferences.isTrustedAccessibilityClient(false)) requestAccessibility()
  else ptt.start()
  refresh()

  // Without the hook (no permission, or Wayland) the panel closes when it loses focus instead.
  overlay.win.on('blur', () => {
    if (!ptt.isRunning) controller.overlayBlurred()
  })

  settings.onChange((current) => {
    ptt.setKey(current.pttKey)
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

  app.on('will-quit', () => ptt.stop())

  if (!getApiKey()) openSettingsWindow()
}

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
