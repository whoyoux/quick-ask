import { app, BrowserWindow } from 'electron'
import { appIcon, keepNavigationInBrowser, loadPage, preloadPath } from './windows'

let historyWindow: BrowserWindow | null = null

export function openHistoryWindow(): void {
  if (historyWindow) {
    historyWindow.show()
    historyWindow.focus()
    return
  }
  historyWindow = new BrowserWindow({
    width: 560,
    height: 640,
    minWidth: 420,
    minHeight: 360,
    show: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    // Resizing briefly exposes the window background; keep it graphite, not white.
    backgroundColor: '#1e1e22',
    title: 'Historia rozmów',
    icon: appIcon(),
    webPreferences: {
      preload: preloadPath('history'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  historyWindow.removeMenu()
  keepNavigationInBrowser(historyWindow)
  historyWindow.once('ready-to-show', () => {
    historyWindow?.show()
    // Without a Dock icon, macOS won't bring our window forward on its own.
    if (process.platform === 'darwin') app.focus({ steal: true })
  })
  historyWindow.on('closed', () => {
    historyWindow = null
  })
  loadPage(historyWindow, 'history')
}

export function closeHistoryWindow(): void {
  historyWindow?.close()
}

export function isHistoryWindow(contents: Electron.WebContents): boolean {
  return historyWindow?.webContents === contents
}

/** Asks an open history window to reload its list. */
export function notifyHistoryWindow(): void {
  historyWindow?.webContents.send('history:changed')
}
