import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '../styles.css'
import { App } from './App'
import { pushLevel, resetLevels } from './levels'
import { Recorder } from './recorder'

const api = window.quickAsk

// Recording is driven by the main process and lives outside React: it must keep working
// while the window is hidden and must not restart when components re-render.
const recorder = new Recorder()
recorder.onLevel = pushLevel

/** Chromium's aliases for the default (and on Windows, communications) device; the tray has its own default item. */
const DEFAULT_DEVICE_IDS = new Set(['default', 'communications'])

// The tray's microphone menu is built from this list. Labels can stay empty until the
// microphone has been used once, so the list is sent again whenever a recording starts.
function reportMicrophones(): void {
  navigator.mediaDevices.enumerateDevices().then(
    (devices) =>
      api.reportMicrophones(
        devices
          .filter((d) => d.kind === 'audioinput' && d.deviceId && !DEFAULT_DEVICE_IDS.has(d.deviceId))
          .map((d) => ({ deviceId: d.deviceId, label: d.label }))
      ),
    () => {}
  )
}
reportMicrophones()
recorder.onOpen = reportMicrophones
navigator.mediaDevices.addEventListener('devicechange', reportMicrophones)

api.onRecorder((command) => {
  if (command.type === 'start') {
    resetLevels()
    recorder.start(command.deviceId)
  } else if (command.type === 'cancel') {
    recorder.cancel()
  } else {
    recorder.stop().then(
      (result) => api.sendRecording({ ok: true, result }),
      (error: unknown) => api.sendRecording({ ok: false, error: error instanceof Error ? error.message : String(error) })
    )
  }
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
