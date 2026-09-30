import { uIOhook, UiohookKey, type UiohookKeyboardEvent } from 'uiohook-napi'
import { debug } from './debug'

// Electron's globalShortcut only reports key presses, never releases, so push-to-talk
// listens to raw keydown/keyup events through libuiohook instead. The hook only observes
// keys (it can't swallow them), which is why the trigger is a lone modifier: holding it
// types nothing into the focused app.

export type PttKeyId = 'ctrl-right' | 'alt-right' | 'shift-right' | 'meta-right'

interface PttKey {
  code: number
  label: string
  family: 'ctrl' | 'alt' | 'shift' | 'meta'
}

export const PTT_KEYS: Record<PttKeyId, PttKey> = {
  'ctrl-right': { code: UiohookKey.CtrlRight, label: 'prawy Ctrl', family: 'ctrl' },
  'alt-right': {
    code: UiohookKey.AltRight,
    label: process.platform === 'darwin' ? 'prawy Option' : 'prawy Alt',
    family: 'alt'
  },
  'shift-right': { code: UiohookKey.ShiftRight, label: 'prawy Shift', family: 'shift' },
  'meta-right': {
    code: UiohookKey.MetaRight,
    label: process.platform === 'darwin' ? 'prawy Command' : 'prawy Win',
    family: 'meta'
  }
}

/** Held shorter than this, the press counts as a tap and nothing is sent. */
const HOLD_THRESHOLD_MS = 250

export interface PushToTalkHandlers {
  /** Trigger went down. Recording may start here so the first word isn't cut off. */
  onPress(): void
  /** Held past the threshold: this is a real push-to-talk. */
  onHold(): void
  /** Released after a hold: stop and send. */
  onRelease(): void
  /** A tap, or the trigger was part of another shortcut: throw the recording away. */
  onCancel(): void
  onEscape(): void
}

type Phase = 'idle' | 'pressed' | 'holding'

export class PushToTalk {
  private phase: Phase = 'idle'
  private holdTimer: NodeJS.Timeout | null = null
  private key: PttKey = PTT_KEYS['ctrl-right']
  private running = false

  constructor(private readonly handlers: PushToTalkHandlers) {
    uIOhook.on('keydown', (event) => this.handleKeyDown(event))
    uIOhook.on('keyup', (event) => this.handleKeyUp(event))
    uIOhook.on('mousedown', () => this.handleMouseDown())
  }

  get isRunning(): boolean {
    return this.running
  }

  setKey(id: PttKeyId): void {
    if (this.phase !== 'idle') this.cancel()
    this.key = PTT_KEYS[id]
  }

  start(): boolean {
    if (this.running) return true
    try {
      uIOhook.start()
      this.running = true
      debug('keyboard hook started')
    } catch (error) {
      console.error('[quick-ask] could not start the keyboard hook', error)
    }
    return this.running
  }

  stop(): void {
    if (!this.running) return
    this.reset()
    uIOhook.stop()
    this.running = false
  }

  private handleKeyDown(event: UiohookKeyboardEvent): void {
    if (event.keycode === this.key.code) {
      debug('trigger down', { phase: this.phase })
      // Auto-repeat keeps firing keydown while the key is held.
      if (this.phase !== 'idle') return
      // Shift + right Ctrl and similar combos belong to someone else.
      if (this.otherModifiersHeld(event)) return
      this.phase = 'pressed'
      this.holdTimer = setTimeout(() => {
        this.holdTimer = null
        if (this.phase !== 'pressed') return
        this.phase = 'holding'
        this.handlers.onHold()
      }, HOLD_THRESHOLD_MS)
      this.handlers.onPress()
      return
    }

    if (this.phase !== 'idle') {
      // Another key while holding the trigger means it was used as a regular modifier (e.g. Ctrl+C).
      debug('cancelled by another key', event.keycode)
      this.cancel()
      return
    }
    if (event.keycode === UiohookKey.Escape) this.handlers.onEscape()
  }

  private handleKeyUp(event: UiohookKeyboardEvent): void {
    if (event.keycode !== this.key.code || this.phase === 'idle') return
    debug('trigger up', { phase: this.phase })
    const wasHolding = this.phase === 'holding'
    this.clearTimer()
    this.phase = 'idle'
    if (wasHolding) this.handlers.onRelease()
    else this.handlers.onCancel()
  }

  private handleMouseDown(): void {
    // Ctrl+click and friends: the trigger is being used as a modifier.
    if (this.phase !== 'idle') {
      debug('cancelled by a mouse click')
      this.cancel()
    }
  }

  private otherModifiersHeld(event: UiohookKeyboardEvent): boolean {
    const held = { ctrl: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey }
    return Object.entries(held).some(([family, down]) => down && family !== this.key.family)
  }

  private cancel(): void {
    this.reset()
    this.handlers.onCancel()
  }

  private reset(): void {
    this.clearTimer()
    this.phase = 'idle'
  }

  private clearTimer(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer)
    this.holdTimer = null
  }
}
