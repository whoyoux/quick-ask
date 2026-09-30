import type { OverlayView, RecorderCommand } from '../shared/types'
import type { ChatWindow } from './chat-window'
import type { OverlayWindow } from './overlay-window'

/**
 * What the controller draws on: the always-on-top recording pill (which also hosts the
 * recorder) and the chat window. The pill shows while recording or for a short notice when no
 * conversation is open; everything else happens in the chat window.
 */
export class Surfaces {
  private view: OverlayView | null = null

  constructor(
    private readonly pill: OverlayWindow,
    private readonly chat: ChatWindow
  ) {}

  /** The recorder lives in the pill's page. */
  get loaded(): boolean {
    return this.pill.loaded
  }

  set onLoad(listener: () => void) {
    this.pill.onLoad = listener
    this.chat.onLoad = listener
  }

  set onRendererLost(listener: () => void) {
    this.pill.onRendererLost = listener
  }

  /** The chat window is open: the next question continues its conversation. */
  get visible(): boolean {
    return this.chat.visible
  }

  render(view: OverlayView): void {
    this.view = view
    this.pill.render(view)
    this.chat.render(view)
    this.syncPill()
  }

  recorder(command: RecorderCommand): void {
    this.pill.recorder(command)
  }

  show(): void {
    if (this.view?.mode === 'panel') this.chat.reveal()
    this.syncPill()
  }

  hide(): void {
    this.chat.hide()
    this.pill.hide()
  }

  /** Shows the chat window and makes it active: the user opened it on purpose. */
  activate(): void {
    this.chat.activate()
    this.syncPill()
  }

  focusInput(): void {
    this.chat.focusInput()
  }

  private syncPill(): void {
    const view = this.view
    if (view && (view.recording !== null || view.mode === 'pill')) this.pill.show()
    else this.pill.hide()
  }
}
