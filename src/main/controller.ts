import { systemPreferences } from 'electron'
import { randomUUID } from 'node:crypto'
import { MAX_ATTACHMENTS, type ImageName, type OverlayView, type RecordingOutcome, type TokenUsage, type Turn } from '../shared/types'
import type { HistoryStore, TurnRecord } from './db/history'
import { debug } from './debug'
import { deleteImages, ImageError, imageDataUrl, storeImage } from './images'
import { modelName } from './models'
import {
  generateImage,
  OpenRouterError,
  streamChat,
  transcribe,
  type ChatMessage,
  type ContentPart,
  type FunctionTool,
  type ToolCall
} from './openrouter'
import type { Surfaces } from './surfaces'
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
/** The renderer normally hands over the audio within milliseconds of a stop. */
const STOP_TIMEOUT_MS = 5000
/** Earlier question/answer pairs sent along with a follow-up. */
const HISTORY_TURNS = 10
/** Streaming tokens are batched into one UI update per interval. */
const RENDER_INTERVAL_MS = 40

type RecorderPhase = 'idle' | 'arming' | 'recording' | 'stopping'

/** A spoken question (still to be transcribed) or a typed one. */
type QuestionInput = { audio: Buffer; mimeType: string } | { text: string }

/** Longer typed questions are cut; this is a quick-question box, not a document editor. */
const MAX_TYPED_LENGTH = 8000

const ASPECT_RATIOS = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']

/** The chat model calls this to make a picture; the image model in the tray menu draws it. */
const IMAGE_TOOL: FunctionTool = {
  name: 'generate_image',
  description:
    'Creates a picture with an image generation model and shows it to the user. Use only when the user asks for an image, drawing, photo, illustration, logo, or to change pictures.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description:
          'Detailed description of the picture in English: subject, style, composition, lighting, and any text to render verbatim. When editing, describe the change.'
      },
      reference: {
        type: 'string',
        enum: ['attached', 'previous', 'none'],
        description:
          '"attached": work from the pictures the user attached to this question. "previous": change the last picture you generated in this conversation. "none": a new picture.'
      },
      aspect_ratio: { type: 'string', enum: ASPECT_RATIOS }
    },
    required: ['prompt', 'reference']
  }
}

function addUsage(turn: Turn, cost: number | null, tokens: TokenUsage | null): void {
  if (cost !== null) turn.costUsd = (turn.costUsd ?? 0) + cost
  if (tokens) {
    turn.tokens = { input: (turn.tokens?.input ?? 0) + tokens.input, output: (turn.tokens?.output ?? 0) + tokens.output }
  }
}

function describeError(error: unknown): string {
  if (error instanceof OpenRouterError || error instanceof ImageError) return error.message
  return `Coś poszło nie tak: ${error instanceof Error ? error.message : String(error)}`
}

interface Conversation {
  /** Its row in the history database. */
  id: string
  /** Cancels this conversation's requests once another one replaces it. */
  requests: AbortController
  /** Saved turns keep the order the questions were asked in, even if answers finish out of order. */
  nextPosition: number
}

export interface ControllerHooks {
  onRecordingChange(recording: boolean): void
  onConversationChange(): void
  /** A turn was saved to the history database. */
  onHistoryChange(): void
  /** OpenRouter billed something, so the balance in the tray is out of date. */
  onSpend(): void
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

function roundMs(ms: number | null): number | null {
  return ms === null ? null : Math.round(ms)
}

/**
 * Owns the conversation and drives the overlay:
 * press → record → transcribe → stream the answer.
 *
 * Thread rule: a question asked while the answer panel is open continues that conversation;
 * once the panel is closed, the next question starts a new one. The panel never closes on its
 * own: only its close button (or the tray) hides it, and the app keeps running in the tray.
 * Each finished turn is saved to the history, from which a conversation can be reopened.
 */
export class Controller {
  private readonly view: OverlayView = {
    mode: 'hidden',
    recording: null,
    notice: null,
    turns: [],
    hint: '',
    attachments: []
  }
  private recorderPhase: RecorderPhase = 'idle'
  private continuing = false
  private handsFree = false
  private maxTimer: NodeJS.Timeout | null = null
  private stopTimer: NodeJS.Timeout | null = null
  private noticeTimer: NodeJS.Timeout | null = null
  private renderTimer: NodeJS.Timeout | null = null
  private conversation: Conversation | null = null
  /**
   * The conversation a fresh question replaced, kept until that question turns out to be real:
   * an accidental hold that transcribes to nothing brings it back instead of wiping it.
   */
  private displaced: { conversation: Conversation | null; turns: Turn[] } | null = null
  private nextTurnId = 1

  constructor(
    private readonly surfaces: Surfaces,
    private readonly hooks: ControllerHooks,
    /** null when the database could not be opened; questions still work, nothing is saved. */
    private readonly history: HistoryStore | null
  ) {
    surfaces.onLoad = () => this.pushView()
    surfaces.onRendererLost = () => this.recorderLost('Nagrywanie przerwane: okno Quick Ask uległo awarii.')
  }

  get isRecording(): boolean {
    return this.recorderPhase === 'recording'
  }

  get hasConversation(): boolean {
    return this.view.turns.length > 0
  }

  // Push-to-talk ---------------------------------------------------------------------------

  keyPressed(): void {
    if (this.recorderPhase !== 'idle' || !this.surfaces.loaded || !getApiKey() || !micPermissionGranted()) return
    this.beginRecording(false)
  }

  keyHeld(): void {
    if (this.ownedByHandsFree()) return
    if (!this.ready()) {
      this.cancelRecording()
      return
    }
    if (this.recorderPhase === 'arming') this.confirmRecording()
  }

  keyReleased(): void {
    if (this.ownedByHandsFree()) return
    if (this.recorderPhase === 'arming') this.cancelRecording()
    else this.finishRecording()
  }

  keyCancelled(): void {
    if (this.ownedByHandsFree()) return
    this.cancelRecording()
  }

  /** A hands-free recording ends from the tray, the panel or `--toggle`; the trigger key leaves it alone. */
  private ownedByHandsFree(): boolean {
    return this.handsFree && this.recorderPhase !== 'idle'
  }

  // Hands-free: tray item or `quick-ask --toggle` --------------------------------------------

  toggleHandsFree(): void {
    if (this.recorderPhase === 'recording') {
      this.finishRecording()
      return
    }
    if (this.recorderPhase !== 'idle' || !this.surfaces.loaded || !this.ready()) return
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
    // Closing the panel mid-question must not leave the microphone on.
    this.cancelRecording(false)
    // Pictures waiting for a question would otherwise ride along with some later one.
    this.clearAttachments()
    this.clearNoticeTimer()
    this.view.mode = 'hidden'
    this.view.notice = null
    this.surfaces.hide()
    this.pushView()
  }

  // Typing ---------------------------------------------------------------------------------

  /** A question typed into the panel; follows the same thread rule as a spoken one. */
  askText(raw: string): void {
    const text = raw.trim().slice(0, MAX_TYPED_LENGTH)
    if (!text) return
    if (!getApiKey()) {
      this.showNotice('Najpierw dodaj klucz API OpenRouter.')
      this.hooks.openSettings()
      return
    }
    void this.ask({ text }, this.surfaces.visible && this.view.mode === 'panel')
  }

  /** Opens the panel with the cursor in the text box (tray: "Napisz pytanie…"). */
  startTyping(): void {
    this.showPanel()
    this.surfaces.focusInput()
  }

  // Attachments ----------------------------------------------------------------------------

  /** Adds pictures for the next question and opens the panel to show them. */
  async attach(load: (room: number) => Promise<ImageName[]> | ImageName[]): Promise<void> {
    const room = MAX_ATTACHMENTS - this.view.attachments.length
    if (room <= 0) {
      this.showPanelNotice(`Do jednego pytania można dołączyć najwyżej ${MAX_ATTACHMENTS} obrazy.`)
      return
    }
    let names: ImageName[]
    try {
      names = await load(room)
    } catch (error) {
      this.showPanelNotice(describeError(error))
      return
    }
    if (names.length === 0) return
    const kept = names.slice(0, MAX_ATTACHMENTS - this.view.attachments.length)
    deleteImages(names.slice(kept.length))
    this.view.attachments = [...this.view.attachments, ...kept]
    if (kept.length < names.length) {
      this.showPanelNotice(`Dołączyłem ${kept.length} z ${names.length}: najwyżej ${MAX_ATTACHMENTS} obrazy na pytanie.`)
    } else {
      this.showPanel()
    }
  }

  removeAttachment(name: ImageName): void {
    if (!this.view.attachments.includes(name)) return
    this.view.attachments = this.view.attachments.filter((n) => n !== name)
    deleteImages([name])
    this.pushView()
  }

  private clearAttachments(): void {
    deleteImages(this.view.attachments)
    this.view.attachments = []
  }

  /** The user asked for the chat window (tray, attach buttons), so it becomes active. */
  private showPanel(): void {
    this.view.mode = 'panel'
    this.pushView()
    this.surfaces.activate()
  }

  private showPanelNotice(text: string): void {
    this.showPanel()
    this.showNotice(text)
  }

  /** Clears the thread but keeps the panel open for the next question. */
  newConversation(): void {
    this.conversation?.requests.abort()
    this.conversation = null
    this.dropDisplaced()
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
    this.surfaces.activate()
  }

  /** Shows a saved conversation in the panel; the next question continues it. */
  openConversation(id: string): boolean {
    const saved = this.history?.turns(id) ?? []
    if (saved.length === 0) return false
    this.cancelRecording()
    this.conversation?.requests.abort()
    this.dropDisplaced()
    this.conversation = { id, requests: new AbortController(), nextPosition: saved[saved.length - 1].position + 1 }
    this.view.turns = saved.map(
      (t): Turn => ({
        id: this.nextTurnId++,
        question: t.question,
        answer: t.answer,
        status: t.status,
        error: t.error,
        timing: {
          transcriptionModel: modelName(t.transcriptionModel),
          transcriptionMs: t.transcriptionMs,
          chatModel: modelName(t.chatModel),
          firstTokenMs: t.firstTokenMs
        },
        costUsd: t.costUsd,
        tokens: t.inputTokens === null && t.outputTokens === null ? null : { input: t.inputTokens ?? 0, output: t.outputTokens ?? 0 },
        sources: t.sources ?? [],
        attachments: t.attachments ?? [],
        images: t.images ?? [],
        generatingImage: false
      })
    )
    this.clearNoticeTimer()
    this.view.mode = 'panel'
    this.view.notice = null
    this.pushView()
    this.surfaces.activate()
    this.hooks.onConversationChange()
    return true
  }

  /** A deleted conversation also leaves the panel; `null` means the whole history was deleted. */
  conversationDeleted(id: string | null): void {
    const matches = (c: Conversation | null | undefined): boolean => Boolean(c) && (id === null || id === c?.id)
    // One set aside by a question still being transcribed must not come back either.
    if (matches(this.displaced?.conversation)) this.dropDisplaced()
    if (matches(this.conversation)) this.newConversation()
  }

  /** A short message in the overlay, e.g. a picture that couldn't be saved. */
  notify(text: string): void {
    this.showNotice(text)
  }

  /** Re-send the view, e.g. after the hint changed with the settings. */
  refresh(): void {
    this.pushView()
  }

  // Recording ------------------------------------------------------------------------------

  handleRecording(outcome: RecordingOutcome): void {
    debug('recording', outcome.ok ? { ...outcome.result, audio: outcome.result.audio.byteLength } : outcome)
    if (this.recorderPhase !== 'stopping') return // cancelled or timed out in the meantime
    this.recorderPhase = 'idle'
    this.clearStopTimer()
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
    void this.ask({ audio: Buffer.from(result.audio), mimeType: result.mimeType }, this.continuing)
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
    this.continuing = this.surfaces.visible && this.view.mode === 'panel'
    this.recorderPhase = 'arming'
    this.surfaces.recorder({ type: 'start', deviceId: settings.get().micDeviceId })
  }

  private confirmRecording(): void {
    this.recorderPhase = 'recording'
    this.clearNoticeTimer()
    this.view.recording = { handsFree: this.handsFree, startedAt: Date.now() }
    this.view.mode = this.continuing ? 'panel' : 'pill'
    this.view.notice = null
    this.pushView()
    this.surfaces.show()
    this.hooks.onRecordingChange(true)
    this.maxTimer = setTimeout(() => this.finishRecording(), MAX_RECORDING_MS)
  }

  private finishRecording(): void {
    if (this.recorderPhase !== 'recording') return
    this.recorderPhase = 'stopping'
    this.clearMaxTimer()
    this.hooks.onRecordingChange(false)
    // The view keeps showing the recording state until the audio arrives (a few ms).
    this.surfaces.recorder({ type: 'stop' })
    // Without an answer from the renderer the recorder would never accept another question.
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      this.surfaces.recorder({ type: 'cancel' })
      this.recorderLost('Nie udało się zakończyć nagrania. Spróbuj ponownie.')
    }, STOP_TIMEOUT_MS)
  }

  private cancelRecording(updateView = true): void {
    if (this.recorderPhase === 'idle' || this.recorderPhase === 'stopping') return
    const wasShown = this.recorderPhase === 'recording'
    this.recorderPhase = 'idle'
    this.clearMaxTimer()
    this.surfaces.recorder({ type: 'cancel' })
    if (!wasShown) return
    this.hooks.onRecordingChange(false)
    this.view.recording = null
    if (!updateView) return
    if (this.continuing) {
      this.view.mode = 'panel'
      this.pushView()
    } else {
      this.hide()
    }
  }

  /** The renderer can't finish this recording (crashed or stopped answering): start over. */
  private recorderLost(message: string): void {
    if (this.recorderPhase === 'idle') return
    const wasShown = this.recorderPhase !== 'arming'
    this.recorderPhase = 'idle'
    this.clearMaxTimer()
    this.clearStopTimer()
    if (!wasShown) return
    this.hooks.onRecordingChange(false)
    this.view.recording = null
    this.showNotice(message)
  }

  // Asking ---------------------------------------------------------------------------------

  private async ask(input: QuestionInput, continuing: boolean): Promise<void> {
    const typed = 'text' in input
    const apiKey = getApiKey()
    if (!apiKey) return
    const current = settings.get()

    if (!continuing || !this.conversation) {
      // The previous conversation keeps going in the background until this question is real.
      this.dropDisplaced()
      this.displaced = { conversation: this.conversation, turns: this.view.turns }
      this.conversation = { id: randomUUID(), requests: new AbortController(), nextPosition: 0 }
      this.view.turns = []
    }
    const conversation = this.conversation
    const { signal } = conversation.requests
    const position = conversation.nextPosition++
    const askedAt = Date.now()
    // Pictures in the panel when the question was asked; they move into the turn once it's real.
    const attached = [...this.view.attachments]
    const turn: Turn = {
      id: this.nextTurnId++,
      question: '',
      answer: '',
      status: typed ? 'answering' : 'transcribing',
      error: null,
      timing: {
        transcriptionModel: typed ? '' : modelName(current.transcriptionModel),
        transcriptionMs: null,
        chatModel: modelName(current.chatModel),
        firstTokenMs: null
      },
      costUsd: null,
      tokens: null,
      sources: [],
      attachments: [],
      images: [],
      generatingImage: false
    }
    this.view.turns.push(turn)
    this.view.mode = 'panel'
    this.view.notice = null
    this.pushView()
    this.surfaces.show()
    this.hooks.onConversationChange()

    try {
      const question = typed ? input.text : await this.transcribe(turn, input, apiKey, signal)
      if (signal.aborted) return
      if (!typed && isLikelyHallucination(question)) {
        this.view.turns = this.view.turns.filter((t) => t !== turn)
        this.restoreDisplaced()
        // An open panel stays open; only a fresh question falls back to the notice pill
        // (the restored conversation is still one click away in the tray).
        if (!continuing && !this.recordingShown()) this.view.mode = 'pill'
        this.hooks.onConversationChange()
        this.showNotice('Nie usłyszałem pytania.')
        return
      }
      this.dropDisplaced()

      // The pictures waiting in the panel go with this question.
      turn.attachments = attached.filter((name) => this.view.attachments.includes(name))
      this.view.attachments = this.view.attachments.filter((name) => !turn.attachments.includes(name))
      turn.question = question
      turn.status = 'answering'
      this.pushView()

      const answerStart = performance.now()
      const chat = await streamChat({
        apiKey,
        model: current.chatModel,
        messages: this.buildMessages(turn),
        webSearch: current.webSearch,
        functions: [IMAGE_TOOL],
        signal,
        onDelta: (text) => {
          turn.timing.firstTokenMs ??= performance.now() - answerStart
          turn.answer += text
          this.scheduleRender()
        },
        onSource: (source) => {
          turn.sources.push(source)
          this.scheduleRender()
        }
      })
      addUsage(turn, chat.cost, chat.tokens)
      this.hooks.onSpend()
      debug('timing', turn.timing, 'cost', turn.costUsd, 'tokens', turn.tokens)
      const imageCall = chat.toolCalls.find((call) => call.name === IMAGE_TOOL.name)
      if (imageCall) await this.drawImage(turn, imageCall, apiKey, current.imageModel, signal)
      if (signal.aborted) return
      if (turn.answer.trim() || turn.images.length > 0) {
        turn.status = 'done'
      } else {
        turn.status = 'error'
        turn.error = 'Model zwrócił pustą odpowiedź. Spróbuj ponownie albo zmień model w menu.'
      }
    } catch (error) {
      if (signal.aborted) return
      this.dropDisplaced()
      // A request that failed half-way may still have been billed.
      if (turn.status === 'answering') this.hooks.onSpend()
      turn.status = 'error'
      turn.error = describeError(error)
    }
    this.pushView()
    this.save(conversation.id, {
      position,
      question: turn.question,
      answer: turn.answer,
      status: turn.status === 'done' ? 'done' : 'error',
      error: turn.error,
      transcriptionModel: typed ? '' : current.transcriptionModel,
      chatModel: current.chatModel,
      transcriptionMs: roundMs(turn.timing.transcriptionMs),
      firstTokenMs: roundMs(turn.timing.firstTokenMs),
      costUsd: turn.costUsd,
      sources: turn.sources.length > 0 ? turn.sources : null,
      inputTokens: turn.tokens?.input ?? null,
      outputTokens: turn.tokens?.output ?? null,
      attachments: turn.attachments.length > 0 ? turn.attachments : null,
      images: turn.images.length > 0 ? turn.images : null,
      createdAt: askedAt
    })
  }

  /** Saves a finished turn. A failed transcription has no question and nothing worth keeping. */
  private save(conversationId: string, record: TurnRecord): void {
    if (!this.history || !settings.get().saveHistory || !record.question) return
    try {
      this.history.saveTurn(conversationId, record)
      this.hooks.onHistoryChange()
    } catch (error) {
      console.error('[quick-ask] could not save the turn to history:', error)
    }
  }

  private async transcribe(
    turn: Turn,
    recording: { audio: Buffer; mimeType: string },
    apiKey: string,
    signal: AbortSignal
  ): Promise<string> {
    const current = settings.get()
    const start = performance.now()
    const transcription = await transcribe({
      apiKey,
      model: current.transcriptionModel,
      audio: recording.audio,
      format: audioFormat(recording.mimeType),
      language: current.language === 'auto' ? null : current.language,
      signal
    })
    turn.timing.transcriptionMs = performance.now() - start
    addUsage(turn, transcription.cost, transcription.tokens)
    this.hooks.onSpend()
    return transcription.text
  }

  /** Runs the model's generate_image call with the image model chosen in the tray. */
  private async drawImage(
    turn: Turn,
    call: ToolCall,
    apiKey: string,
    model: string,
    signal: AbortSignal
  ): Promise<void> {
    let args: { prompt?: unknown; reference?: unknown; aspect_ratio?: unknown }
    try {
      args = JSON.parse(call.arguments || '{}')
    } catch {
      throw new OpenRouterError('Model źle opisał obraz do narysowania. Spróbuj ponownie.')
    }
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!prompt) throw new OpenRouterError('Model nie opisał obrazu do narysowania. Spróbuj ponownie.')
    const previous = this.view.turns.filter((t) => t !== turn && t.images.length > 0).at(-1)
    const references =
      args.reference === 'previous' && previous
        ? previous.images.slice(-1)
        : args.reference === 'none'
          ? []
          : turn.attachments
    const aspectRatio =
      typeof args.aspect_ratio === 'string' && ASPECT_RATIOS.includes(args.aspect_ratio) ? args.aspect_ratio : null
    debug('generate_image', { prompt, reference: args.reference, aspectRatio, references: references.length })

    turn.generatingImage = true
    this.pushView()
    try {
      const result = await generateImage({
        apiKey,
        model,
        prompt,
        aspectRatio,
        references: references.map(imageDataUrl),
        signal
      })
      if (signal.aborted) return
      turn.images.push(...result.images.map((image) => storeImage(image.data, image.mimeType)))
      addUsage(turn, result.cost, result.tokens)
    } finally {
      turn.generatingImage = false
      this.hooks.onSpend()
    }
  }

  /** A question transcribed fine, so the conversation it replaced is gone for good. */
  private dropDisplaced(): void {
    this.displaced?.conversation?.requests.abort()
    this.displaced = null
  }

  /** Brings back the replaced conversation when nothing is left of the new one. */
  private restoreDisplaced(): void {
    if (!this.displaced || this.view.turns.length > 0) return
    this.conversation?.requests.abort()
    this.conversation = this.displaced.conversation
    this.view.turns = this.displaced.turns
    this.displaced = null
  }

  private buildMessages(current: Turn): ChatMessage[] {
    // A follow-up asked while the previous answer is still streaming gets what arrived so far.
    const answered = (t: Turn): boolean =>
      t.status === 'done' || (t.status === 'answering' && (t.answer.trim() !== '' || t.images.length > 0))
    const history = this.view.turns.filter((t) => t !== current && answered(t)).slice(-HISTORY_TURNS)
    const userMessage = (t: Turn): ChatMessage =>
      t.attachments.length === 0
        ? { role: 'user', content: t.question }
        : {
            role: 'user',
            content: [
              { type: 'text', text: t.question },
              ...t.attachments.map((name): ContentPart => ({ type: 'image_url', image_url: { url: imageDataUrl(name) } }))
            ]
          }
    return [
      { role: 'system', content: buildSystemPrompt(settings.get()) },
      ...history.flatMap((t): ChatMessage[] => [
        userMessage(t),
        {
          role: 'assistant',
          content: [t.answer, t.images.length > 0 ? '[Wygenerowany obraz został pokazany użytkownikowi.]' : '']
            .filter(Boolean)
            .join('\n\n')
        }
      ]),
      userMessage(current)
    ]
  }

  // View -----------------------------------------------------------------------------------

  private showNotice(text: string): void {
    this.clearNoticeTimer()
    this.view.notice = text
    const panelOpen = this.surfaces.visible && this.view.mode === 'panel'
    // A notice from an earlier question must not replace a recording in progress.
    if (!panelOpen && !this.recordingShown()) this.view.mode = 'pill'
    this.pushView()
    this.surfaces.show()
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = null
      if (this.view.mode === 'pill' && !this.recordingShown()) {
        this.hide()
      } else {
        this.view.notice = null
        this.pushView()
      }
    }, NOTICE_MS)
  }

  private recordingShown(): boolean {
    return this.view.recording !== null
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
    this.surfaces.render(this.view)
  }

  private clearMaxTimer(): void {
    if (this.maxTimer) clearTimeout(this.maxTimer)
    this.maxTimer = null
  }

  private clearStopTimer(): void {
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.stopTimer = null
  }

  private clearNoticeTimer(): void {
    if (this.noticeTimer) clearTimeout(this.noticeTimer)
    this.noticeTimer = null
  }
}
