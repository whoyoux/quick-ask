import { app, shell, type BrowserWindow } from 'electron'
import { join } from 'node:path'

export type Page = 'overlay' | 'settings' | 'history'

export function preloadPath(page: Page): string {
  return join(__dirname, `../preload/${page}.js`)
}

export function loadPage(win: BrowserWindow, page: Page): void {
  const devServer = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServer) void win.loadURL(`${devServer}/${page}.html`)
  else void win.loadFile(join(__dirname, `../renderer/${page}.html`))
}

function openExternalSafely(url: string): void {
  try {
    const parsed = new URL(url)
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') void shell.openExternal(parsed.toString())
  } catch {
    // Not a URL: ignore.
  }
}

/** Links (e.g. in model answers) open in the browser; our windows never navigate away. */
export function keepNavigationInBrowser(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    openExternalSafely(url)
  })
}
