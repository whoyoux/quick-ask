import { app, BrowserWindow, screen } from 'electron'
import type { OverlayView, RecorderCommand } from '../shared/types'
import { captureWindow, debug, debugEnabled } from './debug'
import type { OverlayPosition } from './settings'
import { keepNavigationInBrowser, loadPage, preloadPath } from './windows'

const INITIAL_SIZE = { width: 600, height: 120 }
/** Default distance from the top of the work area, as a fraction of its height. */
const TOP_OFFSET = 0.08
const MAX_HEIGHT_FRACTION = 0.8
/** Dragging emits many move events on macOS; save the position once it settles. */
const SAVE_POSITION_DELAY_MS = 400

export interface OverlayPlacement {
  /** Where the user last dragged the window, if anywhere. */
  saved(): OverlayPosition | null
  userMoved(position: OverlayPosition): void
}

/**
 * The frameless, transparent, always-on-top window with the recording pill (the conversation
 * itself lives in the chat window). It also hosts the recorder.
 * It stays loaded while hidden so recording can start instantly, and it is shown without
 * taking focus so the user keeps typing in whatever app they were using. The user can drag
 * the pill; that spot is remembered.
 */
export class OverlayWindow {
  readonly win: BrowserWindow
  /** The page is loaded and listening; commands sent before that would be lost. */
  loaded = false
  /** Called after the page (re)loads, so the owner can re-send its state. */
  onLoad: () => void = () => {}
  /** Called when the renderer crashed; anything it was doing (recording) is gone. */
  onRendererLost: () => void = () => {}
  private size = { ...INITIAL_SIZE }
  private userMoving = false
  private saveTimer: NodeJS.Timeout | null = null

  constructor(private readonly placement: OverlayPlacement) {
    const isMac = process.platform === 'darwin'
    this.win = new BrowserWindow({
      ...INITIAL_SIZE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
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
        // The recorder's AudioContext must not start suspended.
        autoplayPolicy: 'no-user-gesture-required'
      }
    })
    if (isMac) this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.keepOnTop()
    // 'will-move' only fires for moves the user makes, unlike 'moved' on macOS, which also
    // reports our own setBounds and moves caused by a display change.
    this.win.on('will-move', () => {
      this.userMoving = true
    })
    this.win.on('moved', () => this.handleMoved())
    this.win.webContents.on('did-finish-load', () => {
      this.loaded = true
      this.onLoad()
    })
    this.win.webContents.on('render-process-gone', (_event, details) => {
      debug('overlay renderer gone', details.reason)
      this.loaded = false
      this.onRendererLost()
      loadPage(this.win, 'overlay')
    })
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
      this.place(this.placement.saved())
      this.win.showInactive()
      this.keepOnTop()
      debug('overlay shown', this.win.getBounds())
    }
    captureWindow(this.win, 'overlay')
  }

  hide(): void {
    this.win.hide()
  }

  /** Makes the overlay the active window and puts the cursor in the panel's text box. */
  focusInput(): void {
    this.show()
    // macOS won't activate a Dock-less app's window on its own.
    if (process.platform === 'darwin') app.focus({ steal: true })
    this.win.focus()
    this.win.webContents.send('overlay:focus-input')
  }

  /**
   * Puts the pill above every other window, again on each show: Windows and Linux can drop
   * "always on top" while the window is hidden, and another always-on-top window (or, on macOS,
   * the workspace setting) may have claimed the top since the pill was last shown.
   */
  private keepOnTop(): void {
    this.win.setAlwaysOnTop(true, 'screen-saver')
    this.win.moveTop()
  }

  /** Back to the default spot, e.g. after "Przywróć położenie okna". */
  resetPosition(): void {
    if (this.visible) this.place(null)
  }

  /** The renderer reports its content size; the window grows from its current top-center. */
  resize(size: { width: number; height: number }): void {
    debug('overlay resize', size)
    this.size = { width: Math.ceil(size.width), height: Math.ceil(size.height) }
    if (!this.visible) return
    const b = this.win.getBounds()
    this.apply({ x: b.x + b.width / 2, y: b.y })
  }

  private place(saved: OverlayPosition | null): void {
    if (saved) {
      this.apply(saved)
      return
    }
    // Default: the screen the user is looking at, i.e. the one with the mouse cursor.
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    this.apply({ x: area.x + area.width / 2, y: area.y + area.height * TOP_OFFSET })
  }

  /** Positions the window by its top-center point, kept fully inside that point's screen. */
  private apply(anchor: OverlayPosition): void {
    const area = screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) }).workArea
    const width = Math.min(this.size.width, area.width)
    const height = Math.min(this.size.height, Math.round(area.height * MAX_HEIGHT_FRACTION))
    const clamp = (value: number, min: number, max: number): number => Math.round(Math.min(Math.max(value, min), max))
    this.win.setBounds({
      x: clamp(anchor.x - width / 2, area.x, area.x + area.width - width),
      y: clamp(anchor.y, area.y, area.y + area.height - height),
      width,
      height
    })
  }

  private handleMoved(): void {
    if (!this.userMoving) return
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.userMoving = false
      const b = this.win.getBounds()
      this.placement.userMoved({ x: Math.round(b.x + b.width / 2), y: b.y })
      debug('overlay moved by user', b)
    }, SAVE_POSITION_DELAY_MS)
  }
}
