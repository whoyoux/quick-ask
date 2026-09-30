import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { OverlayApi, OverlayView, RecorderCommand } from '../shared/types'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T): void => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: OverlayApi = {
  onView: (listener) => subscribe<OverlayView>('overlay:view', listener),
  onRecorder: (listener) => subscribe<RecorderCommand>('overlay:recorder', listener),
  sendRecording: (outcome) => ipcRenderer.send('overlay:recording', outcome),
  resize: (size) => ipcRenderer.send('overlay:resize', size),
  close: () => ipcRenderer.send('overlay:close'),
  togglePin: () => ipcRenderer.send('overlay:toggle-pin'),
  copy: (text) => ipcRenderer.send('overlay:copy', text),
  sendNow: () => ipcRenderer.send('overlay:send-now'),
  cancelRecording: () => ipcRenderer.send('overlay:cancel-recording')
}

contextBridge.exposeInMainWorld('quickAsk', api)
