import { app, BrowserWindow } from 'electron'
import { appIcon, keepNavigationInBrowser, loadPage, preloadPath } from './windows'

let settingsWindow: BrowserWindow | null = null

export function openSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 420,
    show: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    title: 'Quick Ask',
    icon: appIcon(),
    webPreferences: {
      preload: preloadPath('settings'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  settingsWindow.removeMenu()
  keepNavigationInBrowser(settingsWindow)
  settingsWindow.once('ready-to-show', () => {
    settingsWindow?.show()
    // Without a Dock icon, macOS won't bring our window forward on its own.
    if (process.platform === 'darwin') app.focus({ steal: true })
  })
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
  loadPage(settingsWindow, 'settings')
}

export function closeSettingsWindow(): void {
  settingsWindow?.close()
}

export function isSettingsWindow(contents: Electron.WebContents): boolean {
  return settingsWindow?.webContents === contents
}
