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

export interface Turn {
  id: number
  question: string
  answer: string
  status: TurnStatus
  error: string | null
  timing: TurnTiming
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

export interface OverlayApi {
  /** Returns a function that removes the listener. */
  onView(listener: (view: OverlayView) => void): () => void
  onRecorder(listener: (command: RecorderCommand) => void): () => void
  sendRecording(outcome: RecordingOutcome): void
  resize(size: { width: number; height: number }): void
  close(): void
  newConversation(): void
  copy(text: string): void
  sendNow(): void
  cancelRecording(): void
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
