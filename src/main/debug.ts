import type { BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Diagnostics for bug reports: run with QUICK_ASK_DEBUG=1.
export const debugEnabled = process.env.QUICK_ASK_DEBUG === '1'

export function debug(...args: unknown[]): void {
  if (debugEnabled) console.log('[quick-ask]', ...args)
}

/** Saves what a window currently shows to the temp folder (only its own pixels, never the screen). */
export function captureWindow(win: BrowserWindow, name: string): void {
  if (!debugEnabled) return
  setTimeout(() => {
    void win.webContents.capturePage().then((image) => {
      const file = join(tmpdir(), `quick-ask-${name}.png`)
      writeFileSync(file, image.toPNG())
      debug('captured', file, win.getBounds())
    })
  }, 700)
}
