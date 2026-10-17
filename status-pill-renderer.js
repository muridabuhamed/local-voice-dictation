const iconEl = document.getElementById('icon')
const labelEl = document.getElementById('label')

const ICONS = {
  idle: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>',
  recording: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/>',
  processing: '<path d="M21 12a9 9 0 1 1-9-9"/>',
  success: '<polyline points="20 6 9 17 4 12"/>',
  error: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
}

const LABELS = {
  idle: 'Idle',
  recording: 'Recording…',
  processing: 'Transcribing…',
  success: 'Pasted',
  error: 'Error',
}

window.flowPill.onState(({ state, message }) => {
  const cls = ICONS[state] ? state : 'idle'
  iconEl.className = `icon ${cls}`
  iconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[cls]}</svg>`
  labelEl.textContent = message || LABELS[cls] || 'Idle'
})
