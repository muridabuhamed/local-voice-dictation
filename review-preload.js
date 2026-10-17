const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('flowReview', {
  getData: () => ipcRenderer.invoke('review-get-data'),
  onData: (cb) => ipcRenderer.on('review-data', (_event, data) => cb(data)),
  onInsertFailed: (cb) => ipcRenderer.on('review-insert-failed', (_event, message) => cb(message)),
  onCopied: (cb) => ipcRenderer.on('review-copied', () => cb()),

  insert: (text) => ipcRenderer.send('review-insert', text),
  copy: (text) => ipcRenderer.send('review-copy', text),
  retry: () => ipcRenderer.send('review-retry'),
  cancel: () => ipcRenderer.send('review-cancel'),
})
