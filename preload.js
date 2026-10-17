const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flowClone', {
  onStartRecording: (cb) => ipcRenderer.on('start-recording', cb),
  onStopRecording: (cb) => ipcRenderer.on('stop-recording', cb),
  onState: (cb) => ipcRenderer.on('state', (_event, payload) => cb(payload)),
  onHistoryUpdate: (cb) => ipcRenderer.on('history-update', (_event, payload) => cb(payload)),
  onWindowMaximized: (cb) => ipcRenderer.on('window-maximized', (_event, isMax) => cb(isMax)),

  sendRecordingConfig: (sampleRate) => ipcRenderer.send('recording-config', { sampleRate }),
  sendAudioChunk: (arrayBuffer) => ipcRenderer.send('audio-chunk', arrayBuffer),
  sendRecordingStopped: () => ipcRenderer.send('recording-stopped'),
  sendMicError: (name, message) => ipcRenderer.send('mic-error', { name, message }),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),

  getHistory: () => ipcRenderer.invoke('get-history'),
  deleteHistoryEntry: (id) => ipcRenderer.send('history-delete', id),
  copyHistoryEntry: (id) => ipcRenderer.send('history-copy', id),
  recoverHistoryEntry: (id) => ipcRenderer.send('history-recover', id),

  minimizeWindow: () => ipcRenderer.send('win-minimize'),
  toggleMaximizeWindow: () => ipcRenderer.send('win-maximize-toggle'),
  closeWindow: () => ipcRenderer.send('win-close'),
})
