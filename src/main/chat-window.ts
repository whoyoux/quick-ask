import { app, BrowserWindow, screen, type Rectangle } from 'electron'
import type { OverlayView } from '../shared/types'
import { debug } from './debug'
import { appIcon, keepNavigationInBrowser, loadPage, preloadPath } from './windows'

const DEFAULT_SIZE = { width: 640, height: 760 }
const SAVE_BOUNDS_DELAY_MS = 400
const isMac = process.platform === 'darwin'

export interface ChatPlacement {
  saved(): Rectangle | null
  save(bounds: Rectangle): void
}

/**
 * The conversation, as an ordinary app window: it sits in the taskbar, other windows can cover
 * it, and it keeps its size and place. Closing it only hides it, so the conversation stays for
 * "Wróć do ostatniej rozmowy" and the app keeps running in the tray.
 */
export class ChatWindow {
  readonly win: BrowserWindow
  loaded = false
  /** Called after the page (re)loads, so the owner can re-send its state. */
  onLoad: () => void = () => {}
  /** The user closed the window. */
  onClose: () => void = () => {}
  private quitting = false
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private readonly placement: ChatPlacement) {
    this.win = new BrowserWindow({
      ...DEFAULT_SIZE,
      ...this.restoredBounds(),
      minWidth: 420,
      minHeight: 360,
      show: false,
      title: 'Quick Ask',
      icon: appIcon(),
      backgroundColor: '#1e1e22',
      // Our header doubles as the title bar; the system draws only the window buttons.
      titleBarStyle: 'hidden',
      ...(isMac
        ? { trafficLightPosition: { x: 14, y: 13 } }
        : { titleBarOverlay: { color: '#1e1e22', symbolColor: '#a1a1aa', height: 40 } }),
      webPreferences: {
        preload: preloadPath('overlay'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false
      }
    })
    this.win.removeMenu()
    keepNavigationInBrowser(this.win)
    this.win.webContents.on('did-finish-load', () => {
      this.loaded = true
      this.onLoad()
    })
    this.win.webContents.on('render-process-gone', (_event, details) => {
      debug('chat renderer gone', details.reason)
      this.loaded = false
      loadPage(this.win, 'chat')
    })
    this.win.on('close', (event) => {
      if (this.quitting) return
      event.preventDefault()
      this.onClose()
    })
    app.on('before-quit', () => {
      this.quitting = true
    })
    this.win.on('hide', () => {
      if (isMac) app.dock?.hide()
    })
    // 'resized' and 'moved' don't exist on Linux; these fire during the drag, hence the debounce.
    this.win.on('resize', () => this.scheduleSave())
    this.win.on('move', () => this.scheduleSave())
    loadPage(this.win, 'chat')
  }

  get webContents(): Electron.WebContents {
    return this.win.webContents
  }

  /** Open, even if minimized or covered: a new question continues its conversation. */
  get visible(): boolean {
    return this.win.isVisible()
  }

  render(view: OverlayView): void {
    this.win.webContents.send('overlay:view', view)
  }

  /** Brings the window up without taking focus from the app the user is working in. */
  reveal(): void {
    if (isMac) {
      // A window in the app switcher needs the Dock icon.
      void app.dock?.show()
      app.dock?.setIcon(appIcon())
    }
    if (this.win.isMinimized()) this.win.restore()
    else if (!this.win.isVisible()) this.win.showInactive()
    else this.win.moveTop()
  }

  /** Brings the window up and makes it active, e.g. when the user opened it from the tray. */
  activate(): void {
    this.reveal()
    if (isMac) app.focus({ steal: true })
    this.win.show()
    this.win.focus()
  }

  /** Active, with the cursor in the text box. */
  focusInput(): void {
    this.activate()
    this.win.webContents.send('overlay:focus-input')
  }

  hide(): void {
    this.win.hide()
  }

  /** The saved bounds if they are still on a connected screen. */
  private restoredBounds(): Partial<Rectangle> {
    const saved = this.placement.saved()
    if (!saved) return {}
    const area = screen.getDisplayMatching(saved).workArea
    const overlaps =
      saved.x < area.x + area.width && saved.x + saved.width > area.x && saved.y < area.y + area.height && saved.y + saved.height > area.y
    return overlaps ? saved : { width: saved.width, height: saved.height }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      if (!this.win.isDestroyed() && !this.win.isMaximized() && !this.win.isMinimized()) {
        this.placement.save(this.win.getBounds())
      }
    }, SAVE_BOUNDS_DELAY_MS)
  }
}
