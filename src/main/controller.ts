import { systemPreferences } from 'electron'
import type { OverlayView, RecordingOutcome, Turn } from '../shared/types'
import { debug } from './debug'
import { modelName } from './models'
import { OpenRouterError, streamChat, transcribe, type ChatMessage } from './openrouter'
import type { OverlayWindow } from './overlay-window'
import { buildSystemPrompt } from './prompt'
import { getApiKey } from './secrets'
import { settings } from './settings'
import { isLikelyHallucination } from './transcript-filter'

/** Safety net for a key release we never hear about (e.g. macOS secure input). */
const MAX_RECORDING_MS = 90_000
const MIN_RECORDING_MS = 400
const MIN_VOICED_MS = 250
/** Even a quiet room with noise suppression stays above this; below it the input is dead. */
const DEAD_MIC_RMS = 0.0003
const NOTICE_MS = 2500
/** Earlier question/answer pairs sent along with a follow-up. */
const HISTORY_TURNS = 10
/** Streaming tokens are batched into one UI update per interval. */
const RENDER_INTERVAL_MS = 40

type RecorderPhase = 'idle' | 'arming' | 'recording' | 'stopping'

export interface ControllerHooks {
  onRecordingChange(recording: boolean): void
  onConversationChange(): void
  openSettings(): void
  /** Footer hint, e.g. "Przytrzymaj prawy Ctrl, aby dopytać". */
  hint(followUp: boolean): string
}

function audioFormat(mimeType: string): string {
  if (mimeType.includes('wav')) return 'wav'
  if (mimeType.includes('ogg')) return 'ogg'
  if (mimeType.includes('mp4')) return 'm4a'
  return 'webm'
}

function micPermissionGranted(): boolean {
  return process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted'
}

/**
 * Owns the conversation and drives the overlay:
 * press → record → transcribe → stream the answer.
 *
 * Thread rule: a question asked while the answer panel is open continues that conversation;
 * once the panel is closed, the next question starts a new one. The panel never closes on its
 * own: only its close button (or the tray) hides it, and the app keeps running in the tray.
 */
export class Controller {
  private readonly view: OverlayView = {
    mode: 'hidden',
    recording: null,
    notice: null,
    turns: [],
    hint: ''
  }
  private recorderPhase: RecorderPhase = 'idle'
  private continuing = false
  private handsFree = false
  private maxTimer: NodeJS.Timeout | null = null
  private noticeTimer: NodeJS.Timeout | null = null
  private renderTimer: NodeJS.Timeout | null = null
  private conversation: AbortController | null = null
  private nextTurnId = 1

  constructor(
    private readonly overlay: OverlayWindow,
    private readonly hooks: ControllerHooks
  ) {}

  get isRecording(): boolean {
    return this.recorderPhase === 'recording'
  }

  get hasConversation(): boolean {
    return this.view.turns.length > 0
  }

  // Push-to-talk ---------------------------------------------------------------------------

  keyPressed(): void {
    if (this.recorderPhase !== 'idle' || !getApiKey() || !micPermissionGranted()) return
    this.beginRecording(false)
  }

  keyHeld(): void {
    if (!this.ready()) return
    if (this.recorderPhase === 'arming') this.confirmRecording()
  }

  keyReleased(): void {
    this.finishRecording()
  }

  keyCancelled(): void {
    this.cancelRecording()
  }

  // Hands-free: tray item or `quick-ask --toggle` --------------------------------------------

  toggleHandsFree(): void {
    if (this.recorderPhase === 'recording') {
      this.finishRecording()
      return
    }
    if (this.recorderPhase !== 'idle' || !this.ready()) return
    this.beginRecording(true)
    this.confirmRecording()
  }

  sendNow(): void {
    this.finishRecording()
  }

  cancelFromUi(): void {
    this.cancelRecording()
  }

  // Overlay --------------------------------------------------------------------------------

  /** Esc anywhere cancels a recording in progress; it never closes the panel. */
  escape(): void {
    if (this.recorderPhase === 'recording') this.cancelRecording()
  }

  hide(): void {
    this.clearNoticeTimer()
    this.view.mode = 'hidden'
    this.view.notice = null
    this.overlay.hide()
    this.pushView()
  }

  /** Clears the thread but keeps the panel open for the next question. */
  newConversation(): void {
    this.conversation?.abort()
    this.conversation = null
    this.view.turns = []
    this.view.notice = null
    this.pushView()
    this.hooks.onConversationChange()
  }

  showLastConversation(): void {
    if (!this.hasConversation) return
    this.view.mode = 'panel'
    this.view.notice = null
    this.pushView()
    this.overlay.show()
  }

  /** Re-send the view, e.g. after the hint changed with the settings. */
  refresh(): void {
    this.pushView()
  }

  // Recording ------------------------------------------------------------------------------

  handleRecording(outcome: RecordingOutcome): void {
    debug('recording', outcome.ok ? { ...outcome.result, audio: outcome.result.audio.byteLength } : outcome)
    if (this.recorderPhase !== 'stopping') return // cancelled in the meantime
    this.recorderPhase = 'idle'
    this.view.recording = null
    if (!outcome.ok) {
      this.showNotice(`Nie mogę nagrać dźwięku: ${outcome.error}`)
      return
    }
    const { result } = outcome
    if (result.durationMs >= MIN_RECORDING_MS && result.peakRms < DEAD_MIC_RMS) {
      this.showNotice('Mikrofon nie przekazuje dźwięku. Sprawdź, czy nie jest wyciszony.')
      return
    }
    if (result.durationMs < MIN_RECORDING_MS || result.voicedMs < MIN_VOICED_MS) {
      this.showNotice('Nie usłyszałem pytania.')
      return
    }
    void this.ask(Buffer.from(result.audio), result.mimeType, this.continuing)
  }

  private ready(): boolean {
    if (!getApiKey()) {
      this.showNotice('Najpierw dodaj klucz API OpenRouter.')
      this.hooks.openSettings()
      return false
    }
    if (micPermissionGranted()) return true
    if (systemPreferences.getMediaAccessStatus('microphone') === 'not-determined') {
      void systemPreferences.askForMediaAccess('microphone')
      this.showNotice('Zezwól na dostęp do mikrofonu i spróbuj ponownie.')
    } else {
      this.showNotice('Brak dostępu do mikrofonu. Włącz go w Ustawieniach systemowych → Prywatność → Mikrofon.')
    }
    return false
  }

  private beginRecording(handsFree: boolean): void {
    this.handsFree = handsFree
    this.continuing = this.overlay.visible && this.view.mode === 'panel'
    this.recorderPhase = 'arming'
    this.overlay.recorder({ type: 'start', deviceId: null })
  }

  private confirmRecording(): void {
    this.recorderPhase = 'recording'
    this.clearNoticeTimer()
    this.view.recording = { handsFree: this.handsFree, startedAt: Date.now() }
    this.view.mode = this.continuing ? 'panel' : 'pill'
    this.view.notice = null
    this.pushView()
    this.overlay.show()
    this.hooks.onRecordingChange(true)
    this.maxTimer = setTimeout(() => this.finishRecording(), MAX_RECORDING_MS)
  }

  private finishRecording(): void {
    if (this.recorderPhase !== 'recording') return
    this.recorderPhase = 'stopping'
    this.clearMaxTimer()
    this.hooks.onRecordingChange(false)
    // The view keeps showing the recording state until the audio arrives (a few ms).
    this.overlay.recorder({ type: 'stop' })
  }

  private cancelRecording(): void {
    if (this.recorderPhase === 'idle' || this.recorderPhase === 'stopping') return
    const wasShown = this.recorderPhase === 'recording'
    this.recorderPhase = 'idle'
    this.clearMaxTimer()
    this.overlay.recorder({ type: 'cancel' })
    if (!wasShown) return
    this.hooks.onRecordingChange(false)
    this.view.recording = null
    if (this.continuing) {
      this.view.mode = 'panel'
      this.pushView()
    } else {
      this.hide()
    }
  }

  // Asking ---------------------------------------------------------------------------------

  private async ask(audio: Buffer, mimeType: string, continuing: boolean): Promise<void> {
    const apiKey = getApiKey()
    if (!apiKey) return
    const current = settings.get()

    if (!continuing || !this.conversation) {
      this.conversation?.abort()
      this.conversation = new AbortController()
      this.view.turns = []
    }
    const { signal } = this.conversation
    const turn: Turn = {
      id: this.nextTurnId++,
      question: '',
      answer: '',
      status: 'transcribing',
      error: null,
      timing: {
        transcriptionModel: modelName(current.transcriptionModel),
        transcriptionMs: null,
        chatModel: modelName(current.chatModel),
        firstTokenMs: null
      }
    }
    this.view.turns.push(turn)
    this.view.mode = 'panel'
    this.view.notice = null
    this.pushView()
    this.overlay.show()
    this.hooks.onConversationChange()

    try {
      const transcriptionStart = performance.now()
      const question = await transcribe({
        apiKey,
        model: current.transcriptionModel,
        audio,
        format: audioFormat(mimeType),
        language: current.language === 'auto' ? null : current.language,
        signal
      })
      turn.timing.transcriptionMs = performance.now() - transcriptionStart
      if (signal.aborted) return
      if (isLikelyHallucination(question)) {
        this.view.turns = this.view.turns.filter((t) => t !== turn)
        // An open panel stays open; only a fresh question falls back to the notice pill.
        if (!continuing) this.view.mode = 'pill'
        this.hooks.onConversationChange()
        this.showNotice('Nie usłyszałem pytania.')
        return
      }

      turn.question = question
      turn.status = 'answering'
      this.pushView()

      const answerStart = performance.now()
      await streamChat({
        apiKey,
        model: current.chatModel,
        messages: this.buildMessages(turn),
        signal,
        onDelta: (text) => {
          turn.timing.firstTokenMs ??= performance.now() - answerStart
          turn.answer += text
          this.scheduleRender()
        }
      })
      debug('timing', turn.timing)
      if (turn.answer.trim()) {
        turn.status = 'done'
      } else {
        turn.status = 'error'
        turn.error = 'Model zwrócił pustą odpowiedź. Spróbuj ponownie albo zmień model w menu.'
      }
    } catch (error) {
      if (signal.aborted) return
      turn.status = 'error'
      turn.error =
        error instanceof OpenRouterError
          ? error.message
          : `Coś poszło nie tak: ${error instanceof Error ? error.message : String(error)}`
    }
    this.pushView()
  }

  private buildMessages(current: Turn): ChatMessage[] {
    const history = this.view.turns.filter((t) => t !== current && t.status === 'done').slice(-HISTORY_TURNS)
    return [
      { role: 'system', content: buildSystemPrompt(settings.get()) },
      ...history.flatMap((t): ChatMessage[] => [
        { role: 'user', content: t.question },
        { role: 'assistant', content: t.answer }
      ]),
      { role: 'user', content: current.question }
    ]
  }

  // View -----------------------------------------------------------------------------------

  private showNotice(text: string): void {
    this.clearNoticeTimer()
    this.view.notice = text
    this.view.recording = null
    const panelOpen = this.overlay.visible && this.view.mode === 'panel'
    if (!panelOpen) this.view.mode = 'pill'
    this.pushView()
    this.overlay.show()
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      if (this.view.mode === 'pill') {
        this.hide()
      } else {
        this.view.notice = null
        this.pushView()
      }
    }, NOTICE_MS)
  }

  private scheduleRender(): void {
    this.renderTimer ??= setTimeout(() => this.pushView(), RENDER_INTERVAL_MS)
  }

  private pushView(): void {
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderTimer = null
    this.view.hint = this.hooks.hint(this.view.turns.length > 0)
    debug('view', {
      mode: this.view.mode,
      recording: Boolean(this.view.recording),
      notice: this.view.notice,
      turns: this.view.turns.map((t) => t.status)
    })
    this.overlay.render(this.view)
  }

  private clearMaxTimer(): void {
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = null
  }
}
