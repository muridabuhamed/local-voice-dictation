const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flowPill', {
  onState: (cb) => ipcRenderer.on('state', (_event, payload) => cb(payload)),
})
