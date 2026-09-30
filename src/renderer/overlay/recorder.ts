import type { RecordingResult } from '../../shared/types'
import workletUrl from './pcm-capture.worklet.js?url'

/** RMS level above which audio counts as speech. */
const SPEECH_RMS = 0.015
const LEVEL_INTERVAL_MS = 50
/** Speech-to-text models work at 16 kHz; recording at that rate keeps uploads small. */
const TARGET_RATE = 16_000

/**
 * Records one question from the microphone as 16 kHz mono WAV, the one format every
 * transcription model accepts, and tracks how much of it was actually speech so silence
 * never gets sent.
 */
export class Recorder {
  onLevel: (level: number) => void = () => {}

  private generation = 0
  private opening: Promise<void> | null = null
  private stream: MediaStream | null = null
  private context: AudioContext | null = null
  private chunks: Float32Array[] = []
  private startedAt = 0
  private voicedMs = 0
  private peakRms = 0
  private windowPeak = 0
  private lastLevelAt = 0

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
    const context = this.context
    if (!context || generation !== this.generation) throw new Error('mikrofon się nie uruchomił')

    const result: RecordingResult = {
      audio: encodeWav(downsample(concat(this.chunks), context.sampleRate, TARGET_RATE), TARGET_RATE),
      mimeType: 'audio/wav',
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
    const context = new AudioContext()
    const stale = (): boolean => generation !== this.generation
    if (stale()) {
      // Cancelled while the microphone was starting.
      for (const track of stream.getTracks()) track.stop()
      void context.close()
      return
    }
    this.stream = stream
    this.context = context

    await context.audioWorklet.addModule(workletUrl)
    if (stale()) return
    const capture = new AudioWorkletNode(context, 'pcm-capture')
    capture.port.onmessage = (event: MessageEvent<Float32Array>) => this.handleSamples(event.data, context.sampleRate)
    const mute = context.createGain()
    mute.gain.value = 0
    // The graph has to reach the destination to be processed; the gain keeps it silent.
    context.createMediaStreamSource(stream).connect(capture).connect(mute).connect(context.destination)
    await context.resume()
    this.startedAt = performance.now()
    this.lastLevelAt = this.startedAt
  }

  private handleSamples(samples: Float32Array, sampleRate: number): void {
    this.chunks.push(samples)
    let sum = 0
    for (const sample of samples) sum += sample * sample
    const rms = Math.sqrt(sum / samples.length)
    this.peakRms = Math.max(this.peakRms, rms)
    if (rms > SPEECH_RMS) this.voicedMs += (samples.length / sampleRate) * 1000

    this.windowPeak = Math.max(this.windowPeak, rms)
    const now = performance.now()
    if (now - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.onLevel(Math.min(1, this.windowPeak * 9))
      this.windowPeak = 0
      this.lastLevelAt = now
    }
  }

  private teardown(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    void this.context?.close()
    this.context = null
    this.opening = null
  }
}

function concat(chunks: Float32Array[]): Float32Array {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/** Averages each output sample over its input window, which doubles as a simple low-pass filter. */
function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate) return input
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.floor(input.length / ratio))
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio)
    const end = Math.min(input.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j++) sum += input[j]
    out[i] = sum / Math.max(1, end - start)
  }
  return out
}

/** 16-bit PCM mono WAV. */
function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const text = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i))
  }
  text(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  view.setUint32(16, 16, true) // fmt chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  text(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return buffer
}
