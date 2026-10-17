const statusEl = document.getElementById('status')
const statusIconEl = document.getElementById('status-icon')
const setupBanner = document.getElementById('setup-banner')
const greetingEl = document.getElementById('greeting')

const hotkeyInput = document.getElementById('hotkey-input')
const reviewModeCheckbox = document.getElementById('review-mode-checkbox')
const settingsForm = document.getElementById('settings-form')
const settingsMsg = document.getElementById('settings-msg')

const historyListEl = document.getElementById('history-list')
const historyEmptyEl = document.getElementById('history-empty')
const searchToggle = document.getElementById('search-toggle')
const searchBox = document.getElementById('search-box')
const historySearch = document.getElementById('history-search')

const statWords = document.getElementById('stat-words')
const statWpm = document.getElementById('stat-wpm')
const statStreak = document.getElementById('stat-streak')
const infoModel = document.getElementById('info-model')
const infoHotkey = document.getElementById('info-hotkey')

let audioContext
let workletNode
let micStream
let latestHistory = { entries: [], stats: { totalWords: 0, wpm: 0, streak: 0 } }

// ---- status icon (small hand-authored line icons, swapped per state) ------

const ICONS = {
  idle: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  recording: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>',
  processing: '<path d="M21 12a9 9 0 1 1-9-9"/>',
  reviewing: '<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/>',
  success: '<polyline points="20 6 9 17 4 12"/>',
  error: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
}

function setStatus(label, cls) {
  statusEl.textContent = label
  statusIconEl.className = `status-icon ${cls}`
  statusIconEl.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">${ICONS[cls] || ICONS.idle}</svg>`
}

function floatArrayToArrayBuffer(float32Array) {
  return float32Array.buffer
}

window.flowClone.onState(({ state, message }) => {
  if (state === 'idle') setStatus('Idle', 'idle')
  if (state === 'recording') setStatus('Recording…', 'recording')
  if (state === 'processing') setStatus('Transcribing…', 'processing')
  if (state === 'reviewing') setStatus('Reviewing…', 'reviewing')
  if (state === 'success') setStatus(message || 'Pasted', 'success')
  if (state === 'error') setStatus(message || 'Error', 'error')
})

window.flowClone.onStartRecording(async () => {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    window.flowClone.sendMicError(err.name, err.message)
    return
  }

  audioContext = new AudioContext()
  await audioContext.audioWorklet.addModule('recorder-processor.js')

  window.flowClone.sendRecordingConfig(audioContext.sampleRate)

  const source = audioContext.createMediaStreamSource(micStream)
  workletNode = new AudioWorkletNode(audioContext, 'dictation-recorder')
  workletNode.port.onmessage = (event) => {
    window.flowClone.sendAudioChunk(floatArrayToArrayBuffer(event.data))
  }
  source.connect(workletNode)
  // Intentionally not connected to audioContext.destination — we only need
  // the samples, not to play the mic back out of the speakers.
})

window.flowClone.onStopRecording(async () => {
  const node = workletNode
  if (!node) return

  micStream?.getTracks().forEach((t) => t.stop())

  await new Promise((resolve) => {
    const forwardChunks = node.port.onmessage
    node.port.onmessage = (event) => {
      if (event.data === 'flushed') {
        node.port.onmessage = forwardChunks
        resolve()
        return
      }
      forwardChunks(event)
    }
    node.port.postMessage('flush')
  })

  node.disconnect()
  audioContext?.close()
  workletNode = null
  audioContext = null
  micStream = null
  window.flowClone.sendRecordingStopped()
})

// ---- sidebar navigation ------------------------------------------------------

const UNAVAILABLE_LABELS = {
  notetaker: 'Notetaker',
  insights: 'Insights',
  dictionary: 'Dictionary',
  snippets: 'Snippets',
  style: 'Style',
  transforms: 'Transforms',
  scratchpad: 'Scratchpad',
}

function showView(viewName) {
  document.querySelectorAll('.nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewName)
  })
  document.querySelectorAll('.view').forEach((section) => section.classList.remove('active'))

  if (viewName === 'dictation') {
    document.getElementById('view-dictation').classList.add('active')
  } else if (viewName === 'settings') {
    document.getElementById('view-settings').classList.add('active')
  } else {
    document.getElementById('unavailable-title').textContent = `${UNAVAILABLE_LABELS[viewName] || 'This feature'} isn't available`
    document.getElementById('view-unavailable').classList.add('active')
  }
}

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.view))
})
document.querySelectorAll('[data-view-link]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.viewLink))
})

document.getElementById('sidebar-toggle').addEventListener('click', () => {
  document.getElementById('sidebar').classList.toggle('collapsed')
})

// ---- window chrome ------------------------------------------------------------

document.getElementById('win-minimize').addEventListener('click', () => window.flowClone.minimizeWindow())
document.getElementById('win-maximize').addEventListener('click', () => window.flowClone.toggleMaximizeWindow())
document.getElementById('win-close').addEventListener('click', () => window.flowClone.closeWindow())

window.flowClone.onWindowMaximized((isMax) => {
  document.getElementById('win-maximize').innerHTML = isMax
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="7" y="7" width="11" height="11" rx="1.5"/><path d="M7 7V5.5A1.5 1.5 0 0 1 8.5 4H17a1.5 1.5 0 0 1 1.5 1.5V14a1.5 1.5 0 0 1-1.5 1.5H17"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="5" y="5" width="14" height="14" rx="1.5"/></svg>'
})

// ---- settings -----------------------------------------------------------------

async function refreshSettingsUI() {
  const settings = await window.flowClone.getSettings()
  hotkeyInput.value = settings.hotkey
  reviewModeCheckbox.checked = settings.reviewMode
  setupBanner.hidden = settings.whisperReady

  const name = settings.osUsername ? settings.osUsername.split(/[\\/]/).pop() : ''
  const greetingName = name ? `Hey ${name}, ` : 'Hey, '
  greetingEl.innerHTML = `${greetingName}press ${renderKeyBadges(settings.hotkey)} to dictate`

  infoModel.textContent = settings.whisperReady ? 'ggml-base.en (local)' : 'not installed'
  infoHotkey.textContent = settings.hotkey
}

function renderKeyBadges(hotkey) {
  const labelFor = (part) =>
    ({ Control: 'Ctrl', CommandOrControl: 'Ctrl', Command: 'Cmd', Super: 'Win' })[part] || part
  return hotkey
    .split('+')
    .map((part) => `<span class="key-badge">${labelFor(part)}</span>`)
    .join(' + ')
}

settingsForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const result = await window.flowClone.saveSettings({
    hotkey: hotkeyInput.value.trim(),
    reviewMode: reviewModeCheckbox.checked,
  })
  settingsMsg.textContent = result.ok ? 'Saved.' : 'Invalid shortcut — reverted.'
  settingsMsg.className = result.ok ? 'ok' : 'err'
  hotkeyInput.value = result.settings.hotkey
  await refreshSettingsUI()
  setTimeout(() => {
    settingsMsg.textContent = ''
  }, 2500)
})

// ---- history / stats (real data only — rendered straight from main's store) --

const STATUS_META = {
  pasted: null,
  copied: { note: 'Copied to clipboard.' },
  cancelled: { note: 'This transcription was cancelled.', recoverable: true },
  error: { note: 'Could not paste automatically.', recoverable: true },
}

const ARABIC_RE = /[؀-ۿ]/

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function dayLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date()
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function escapeHtml(s) {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}

function renderHistory(filterText) {
  const entries = filterText
    ? latestHistory.entries.filter((e) => e.text.toLowerCase().includes(filterText.toLowerCase()))
    : latestHistory.entries

  historyListEl.innerHTML = ''
  historyEmptyEl.hidden = entries.length > 0

  let lastDay = null
  for (const entry of entries) {
    const label = dayLabel(entry.timestamp)
    if (label !== lastDay) {
      lastDay = label
      const header = document.createElement('div')
      header.className = 'section-label'
      header.style.margin = '14px 0 4px'
      header.textContent = label
      historyListEl.appendChild(header)
    }

    const row = document.createElement('div')
    row.className = 'history-row has-text'

    const meta = STATUS_META[entry.status]
    const isRtl = ARABIC_RE.test(entry.text)

    row.innerHTML = `
      <div class="history-time">${formatTime(entry.timestamp)}</div>
      <div class="history-content${isRtl ? ' rtl' : ''}">
        ${escapeHtml(entry.text)}
        ${meta ? `<div class="history-meta">${meta.note}${meta.recoverable ? ' <a class="recover-link" data-recover="' + entry.id + '">Recover</a>' : ''}</div>` : ''}
      </div>
      <div class="history-actions">
        <button type="button" class="icon-btn" data-copy="${entry.id}" title="Copy">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>
        </button>
        <button type="button" class="icon-btn" data-delete="${entry.id}" title="Delete">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
        </button>
      </div>
    `
    historyListEl.appendChild(row)
  }
}

historyListEl.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('[data-copy]')
  const deleteBtn = e.target.closest('[data-delete]')
  const recoverLink = e.target.closest('[data-recover]')
  if (copyBtn) window.flowClone.copyHistoryEntry(Number(copyBtn.dataset.copy))
  if (deleteBtn) window.flowClone.deleteHistoryEntry(Number(deleteBtn.dataset.delete))
  if (recoverLink) window.flowClone.recoverHistoryEntry(Number(recoverLink.dataset.recover))
})

function renderStats() {
  statWords.textContent = latestHistory.stats.totalWords.toLocaleString()
  statWpm.textContent = latestHistory.stats.wpm.toLocaleString()
  statStreak.textContent = latestHistory.stats.streak.toLocaleString()
}

window.flowClone.onHistoryUpdate((payload) => {
  latestHistory = payload
  renderHistory(historySearch.value.trim())
  renderStats()
})

searchToggle.addEventListener('click', () => {
  const willOpen = !searchBox.classList.contains('open')
  searchBox.classList.toggle('open', willOpen)
  if (willOpen) historySearch.focus()
  else {
    historySearch.value = ''
    renderHistory('')
  }
})
historySearch.addEventListener('input', () => renderHistory(historySearch.value.trim()))

async function loadHistory() {
  latestHistory = await window.flowClone.getHistory()
  renderHistory('')
  renderStats()
}

// ---- init ---------------------------------------------------------------------

setStatus('Idle', 'idle')
refreshSettingsUI()
loadHistory()
