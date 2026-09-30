import { app, BrowserWindow } from 'electron'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from './db/history'
import { loadPage, preloadPath, type Page } from './windows'

// `quick-ask --smoke-test` checks that a packaged build starts at all: the key hook's native
// module loaded (the app would have crashed before getting here), the migrations apply from
// inside app.asar, and every page loads with its preload. It uses a throwaway profile and
// never touches the keychain, the tray or the key listener, so CI can run it on every OS.
// scripts/smoke-test.ts launches it.

const PAGES: Page[] = ['overlay', 'settings', 'history']
/** How long a page may take to mount React after it loaded. */
const RENDER_TIMEOUT_MS = 10_000

/** Must run before `ready`, so Electron never opens the user's own profile. */
export function useSmokeTestProfile(): void {
  app.setPath('userData', mkdtempSync(join(tmpdir(), 'quick-ask-smoke-')))
}

export async function runSmokeTest(): Promise<void> {
  new HistoryStore(join(app.getPath('userData'), 'history.db'), join(app.getAppPath(), 'drizzle')).close()
  for (const page of PAGES) await checkPage(page)
}

async function checkPage(page: Page): Promise<void> {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { preload: preloadPath(page), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  const contents = win.webContents
  try {
    await new Promise<void>((resolve, reject) => {
      contents.once('preload-error', (_event, path, error) => reject(new Error(`${page}: ${path}: ${error.message}`)))
      contents.once('did-fail-load', (_event, code, description) => reject(new Error(`${page}: ${description} (${code})`)))
      contents.once('render-process-gone', (_event, details) => reject(new Error(`${page}: renderer ${details.reason}`)))
      contents.once('did-finish-load', () => resolve())
      loadPage(win, page)
    })
    // Pages render nothing until the main process answers them, so check that the preload
    // exposed its API and the bundle got as far as React's createRoot (which tags the root).
    const mounted: boolean = await contents.executeJavaScript(`new Promise((resolve) => {
      const deadline = Date.now() + ${RENDER_TIMEOUT_MS}
      const check = () => {
        const root = document.getElementById('root')
        const ok = typeof window.quickAsk === 'object' && !!root && Object.keys(root).some((k) => k.startsWith('__reactContainer$'))
        if (ok || Date.now() > deadline) resolve(ok)
        else setTimeout(check, 50)
      }
      check()
    })`)
    if (!mounted) throw new Error(`${page}: the page loaded but the app did not start in it`)
    console.log(`[quick-ask] smoke test: ${page} ok`)
  } finally {
    win.destroy()
  }
}
