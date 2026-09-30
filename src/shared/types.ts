// Contracts shared by the main process, preloads and renderers.

export type TurnStatus = 'transcribing' | 'answering' | 'done' | 'error'

/** How long each step took, shown under the answer to help compare models. */
export interface TurnTiming {
  transcriptionModel: string
  transcriptionMs: number | null
  chatModel: string
  /** From sending the question to the first answer token. */
  firstTokenMs: number | null
}

/** A web page the answer is based on, reported by the web search tool. */
export interface Source {
  url: string
  title: string
}

export interface TokenUsage {
  /** Prompt tokens, including the transcribed audio and attached images. */
  input: number
  /** Answer tokens, including reasoning. */
  output: number
}

/**
 * A picture the user attached or a model generated, stored as a file in the app's images
 * folder and shown through the `qa-image:` protocol. `name` is the file name.
 */
export type ImageName = string

export interface Turn {
  id: number
  question: string
  answer: string
  status: TurnStatus
  error: string | null
  timing: TurnTiming
  /** USD for transcription plus answer; null while unknown. */
  costUsd: number | null
  /** Tokens for transcription, answer and image generation; null while unknown. */
  tokens: TokenUsage | null
  /** Pages found by web search, in the order the model cited them. */
  sources: Source[]
  /** Pictures sent along with the question. */
  attachments: ImageName[]
  /** Pictures the image model made for this answer. */
  images: ImageName[]
  /** An image is being generated (shown as a placeholder). */
  generatingImage: boolean
}

export interface RecordingIndicator {
  /** Started without holding a key (tray item or `--toggle`), so the UI shows send/cancel buttons. */
  handsFree: boolean
  /** Epoch ms, used by the renderer to show elapsed time. */
  startedAt: number
}

export interface OverlayView {
  /** `pill` = small recording/notice bubble, `panel` = conversation. */
  mode: 'hidden' | 'pill' | 'panel'
  recording: RecordingIndicator | null
  notice: string | null
  turns: Turn[]
  /** Footer hint, e.g. how to ask a follow-up. */
  hint: string
  /** Pictures waiting to go with the next question. */
  attachments: ImageName[]
}

/** At most this many pictures go with one question. */
export const MAX_ATTACHMENTS = 3

/** A file dropped onto the panel, read by the renderer. */
export interface DroppedFile {
  name: string
  type: string
  data: ArrayBuffer
}

export type RecorderCommand =
  | { type: 'start'; deviceId: string | null }
  | { type: 'stop' }
  | { type: 'cancel' }

export interface RecordingResult {
  audio: ArrayBuffer
  mimeType: string
  durationMs: number
  /** How long the input level stayed above the speech threshold. */
  voicedMs: number
  /** Loudest 50 ms frame (RMS). Near zero means the microphone delivers no signal at all. */
  peakRms: number
}

export type RecordingOutcome = { ok: true; result: RecordingResult } | { ok: false; error: string }

/** An audio input as the overlay's Chromium sees it. */
export interface Microphone {
  deviceId: string
  /** Can be empty until the microphone has been used once. */
  label: string
}

export interface OverlayApi {
  /** Returns a function that removes the listener. */
  onView(listener: (view: OverlayView) => void): () => void
  onRecorder(listener: (command: RecorderCommand) => void): () => void
  sendRecording(outcome: RecordingOutcome): void
  reportMicrophones(microphones: Microphone[]): void
  resize(size: { width: number; height: number }): void
  close(): void
  newConversation(): void
  copy(text: string): void
  sendNow(): void
  cancelRecording(): void
  askText(text: string): void
  /** The tray's "Napisz pytanie…" asks the panel to focus its text box. */
  onFocusInput(listener: () => void): () => void
  attachClipboard(): void
  attachFiles(): void
  attachDropped(files: DroppedFile[]): void
  removeAttachment(name: ImageName): void
  copyImage(name: ImageName): void
  saveImage(name: ImageName): void
  openImage(name: ImageName): void
}

export interface SetupStatus {
  platform: string
  hasKey: boolean
  maskedKey: string | null
  /** macOS only: global key listening needs the Accessibility permission. */
  needsAccessibility: boolean
  pttLabel: string
}

export interface KeyCheckResult {
  ok: boolean
  message: string
}

export type ExternalLink = 'keys' | 'credits'

export interface SettingsApi {
  getStatus(): Promise<SetupStatus>
  saveKey(key: string): Promise<KeyCheckResult>
  removeKey(): Promise<void>
  requestAccessibility(): Promise<void>
  openLink(link: ExternalLink): void
  close(): void
}

export interface ConversationSummary {
  id: string
  title: string
  /** Epoch ms of the last saved question. */
  updatedAt: number
  /** The first answer as one line of plain text. */
  snippet: string
  /** USD for the whole conversation; null when no turn has a known cost. */
  costUsd: number | null
  /** Tokens for the whole conversation; null when no turn has a known count. */
  tokens: number | null
}

export interface HistoryList {
  /** False when the history database could not be opened. */
  available: boolean
  /** The tray's "Zapisuj historię rozmów" switch. */
  saving: boolean
  conversations: ConversationSummary[]
}

export interface HistoryApi {
  list(query: string): Promise<HistoryList>
  /** Shows the conversation in the answer panel, where it can be continued. False if it's gone. */
  open(id: string): Promise<boolean>
  remove(id: string): Promise<void>
  clear(): Promise<void>
  /** Returns a function that removes the listener. */
  onChange(listener: () => void): () => void
  close(): void
}
