import { contextBridge, ipcRenderer } from 'electron'
import type { SettingsApi } from '../shared/types'

const api: SettingsApi = {
  getStatus: () => ipcRenderer.invoke('settings:status'),
  saveKey: (key) => ipcRenderer.invoke('settings:save-key', key),
  removeKey: () => ipcRenderer.invoke('settings:remove-key'),
  requestAccessibility: () => ipcRenderer.invoke('settings:request-accessibility'),
  openLink: (link) => ipcRenderer.send('settings:open-link', link),
  close: () => ipcRenderer.send('settings:close')
}

contextBridge.exposeInMainWorld('quickAsk', api)
