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
