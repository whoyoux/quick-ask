import { useSyncExternalStore } from 'react'

// Microphone levels, pushed by the recorder ~20 times a second and read by the meters.
// A short scrolling history reads as a live waveform.

export const METER_BARS = 7

let levels: number[] = new Array(METER_BARS).fill(0)
const listeners = new Set<() => void>()

export function pushLevel(level: number): void {
  levels = [...levels.slice(1), level]
  for (const listener of listeners) listener()
}

export function resetLevels(): void {
  levels = new Array(METER_BARS).fill(0)
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useLevels(): number[] {
  return useSyncExternalStore(subscribe, () => levels)
}
