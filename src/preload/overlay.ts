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
  reportMicrophones: (microphones) => ipcRenderer.send('overlay:microphones', microphones),
  resize: (size) => ipcRenderer.send('overlay:resize', size),
  close: () => ipcRenderer.send('overlay:close'),
  newConversation: () => ipcRenderer.send('overlay:new-conversation'),
  copy: (text) => ipcRenderer.send('overlay:copy', text),
  sendNow: () => ipcRenderer.send('overlay:send-now'),
  cancelRecording: () => ipcRenderer.send('overlay:cancel-recording'),
  attachClipboard: () => ipcRenderer.send('overlay:attach-clipboard'),
  attachFiles: () => ipcRenderer.send('overlay:attach-files'),
  attachDropped: (files) => ipcRenderer.send('overlay:attach-dropped', files),
  removeAttachment: (name) => ipcRenderer.send('overlay:remove-attachment', name),
  copyImage: (name) => ipcRenderer.send('overlay:copy-image', name),
  saveImage: (name) => ipcRenderer.send('overlay:save-image', name),
  openImage: (name) => ipcRenderer.send('overlay:open-image', name)
}

contextBridge.exposeInMainWorld('quickAsk', api)
