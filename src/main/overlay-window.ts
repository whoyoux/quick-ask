import { BrowserWindow, screen, type Display } from 'electron'
import type { OverlayView, RecorderCommand } from '../shared/types'
import { captureWindow, debug, debugEnabled } from './debug'
import { keepNavigationInBrowser, loadPage, preloadPath } from './windows'

const INITIAL_SIZE = { width: 600, height: 120 }
/** Distance from the top of the work area, as a fraction of its height. */
const TOP_OFFSET = 0.08
const MAX_HEIGHT_FRACTION = 0.8

/**
 * The frameless, transparent window that hosts both the recording pill and the answer panel.
 * It stays loaded while hidden so recording can start instantly, and it is shown without
 * taking focus so the user keeps typing in whatever app they were using.
 */
export class OverlayWindow {
  readonly win: BrowserWindow
  private size = { ...INITIAL_SIZE }
  private display: Display | null = null

  constructor() {
    const isMac = process.platform === 'darwin'
    this.win = new BrowserWindow({
      ...INITIAL_SIZE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      // macOS: a non-activating panel that can float over full-screen apps.
      // Windows: a tool window, hidden from Alt+Tab.
      type: isMac ? 'panel' : process.platform === 'win32' ? 'toolbar' : undefined,
      webPreferences: {
        preload: preloadPath('overlay'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
        // Recording happens while the window is hidden; keep timers and audio running.
        backgroundThrottling: false,
        // The level meter's AudioContext must not start suspended.
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    this.win.setAlwaysOnTop(true, 'screen-saver')
    if (isMac) this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    keepNavigationInBrowser(this.win)
    if (debugEnabled) this.win.webContents.on('console-message', (event) => debug('overlay console:', event.message))
    loadPage(this.win, 'overlay')
  }

  get webContents(): Electron.WebContents {
    return this.win.webContents
  }

  get visible(): boolean {
    return this.win.isVisible()
  }

  render(view: OverlayView): void {
    this.win.webContents.send('overlay:view', view)
  }

  recorder(command: RecorderCommand): void {
    this.win.webContents.send('overlay:recorder', command)
  }

  show(): void {
    if (!this.visible) {
      // Appear on the screen the user is looking at, i.e. the one with the mouse cursor.
      this.display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      this.applyBounds()
      this.win.showInactive()
      debug('overlay shown', this.win.getBounds())
    }
    captureWindow(this.win, 'overlay')
  }

  hide(): void {
    this.win.hide()
  }

  /** The renderer reports its content size; the window follows it. */
  resize(size: { width: number; height: number }): void {
    debug('overlay resize', size)
    this.size = { width: Math.ceil(size.width), height: Math.ceil(size.height) }
    if (this.visible) this.applyBounds()
  }

  containsCursor(): boolean {
    const { x, y } = screen.getCursorScreenPoint()
    const b = this.win.getBounds()
    return x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
  }

  private applyBounds(): void {
    const area = (this.display ?? screen.getPrimaryDisplay()).workArea
    const width = Math.min(this.size.width, area.width)
    const height = Math.min(this.size.height, Math.round(area.height * MAX_HEIGHT_FRACTION))
    this.win.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + area.height * TOP_OFFSET),
      width,
      height
    })
  }
}
