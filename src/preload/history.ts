import { contextBridge, ipcRenderer } from 'electron'
import type { HistoryApi } from '../shared/types'

const api: HistoryApi = {
  list: (query) => ipcRenderer.invoke('history:list', query),
  open: (id) => ipcRenderer.invoke('history:open', id),
  remove: (id) => ipcRenderer.invoke('history:delete', id),
  clear: () => ipcRenderer.invoke('history:clear'),
  onChange: (listener) => {
    const handler = (): void => listener()
    ipcRenderer.on('history:changed', handler)
    return () => ipcRenderer.removeListener('history:changed', handler)
  },
  close: () => ipcRenderer.send('history:close')
}

contextBridge.exposeInMainWorld('quickAsk', api)
