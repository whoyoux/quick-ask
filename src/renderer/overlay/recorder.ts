import type { RecordingResult } from '../../shared/types'

/** RMS level above which a 50 ms frame counts as speech. */
const SPEECH_RMS = 0.015
const LEVEL_INTERVAL_MS = 50
const MIME_TYPE = 'audio/webm;codecs=opus'

/**
 * Records one question from the microphone as webm/opus and tracks how much of it
 * was actually speech, so silence never gets sent for transcription.
 */
export class Recorder {
  onLevel: (level: number) => void = () => {}

  private generation = 0
  private opening: Promise<void> | null = null
  private stream: MediaStream | null = null
  private recorder: MediaRecorder | null = null
  private audioContext: AudioContext | null = null
  private levelTimer: number | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private voicedMs = 0
  private peakRms = 0

  start(deviceId: string | null): void {
    this.teardown()
    const generation = ++this.generation
    this.chunks = []
    this.voicedMs = 0
    this.peakRms = 0
    this.opening = this.open(deviceId, generation)
    // Errors surface from stop(); don't let them go unhandled if the recording is cancelled.
    this.opening.catch(() => {})
  }

  async stop(): Promise<RecordingResult> {
    const generation = this.generation
    await this.opening
    const recorder = this.recorder
    if (!recorder || generation !== this.generation) throw new Error('mikrofon się nie uruchomił')

    const stopped = new Promise<void>((resolve) => recorder.addEventListener('stop', () => resolve(), { once: true }))
    recorder.stop()
    await stopped
    const result: RecordingResult = {
      audio: await new Blob(this.chunks, { type: recorder.mimeType }).arrayBuffer(),
      mimeType: recorder.mimeType,
      durationMs: performance.now() - this.startedAt,
      voicedMs: this.voicedMs,
      peakRms: this.peakRms
    }
    this.teardown()
    return result
  }

  cancel(): void {
    this.generation++
    this.teardown()
  }

  private async open(deviceId: string | null, generation: number): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    if (generation !== this.generation) {
      // Cancelled while the microphone was starting.
      for (const track of stream.getTracks()) track.stop()
      return
    }
    this.stream = stream

    const recorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported(MIME_TYPE) ? MIME_TYPE : undefined,
      audioBitsPerSecond: 32_000
    })
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) this.chunks.push(event.data)
    })
    recorder.start()
    this.recorder = recorder
    this.startedAt = performance.now()
    this.meterLevels(stream)
  }

  private meterLevels(stream: MediaStream): void {
    const context = new AudioContext()
    void context.resume()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    this.audioContext = context

    const samples = new Float32Array(analyser.fftSize)
    let last = performance.now()
    // setInterval rather than requestAnimationFrame: the window is often hidden while recording.
    this.levelTimer = window.setInterval(() => {
      analyser.getFloatTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) sum += sample * sample
      const rms = Math.sqrt(sum / samples.length)
      const now = performance.now()
      this.peakRms = Math.max(this.peakRms, rms)
      if (rms > SPEECH_RMS) this.voicedMs += now - last
      last = now
      this.onLevel(Math.min(1, rms * 9))
    }, LEVEL_INTERVAL_MS)
  }

  private teardown(): void {
    if (this.levelTimer !== null) window.clearInterval(this.levelTimer)
    this.levelTimer = null
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.recorder = null
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    void this.audioContext?.close()
    this.audioContext = null
    this.opening = null
  }
}
