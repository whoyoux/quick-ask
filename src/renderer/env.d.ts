import type { HistoryApi, OverlayApi, SettingsApi } from '../shared/types'

declare global {
  interface Window {
    // Each page gets the API of its own preload.
    quickAsk: OverlayApi & SettingsApi & HistoryApi
  }
}

export {}
