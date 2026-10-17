const textarea = document.getElementById('transcript-edit')
const warningEl = document.getElementById('warning')
const statusEl = document.getElementById('status')

function showWarning(message) {
  warningEl.textContent = message
  warningEl.hidden = false
}

function applyData(data) {
  if (!data) return
  textarea.value = data.text || ''
  textarea.focus()
  textarea.select()
  if (data.targetUnavailable) {
    showWarning(
      'Original window is no longer available. Edit if needed, then try Insert again ' +
        '(it will try to refocus the original app), or Copy and paste manually.',
    )
  }
}

window.flowReview.getData().then(applyData)
window.flowReview.onData(applyData)

window.flowReview.onInsertFailed((message) => {
  statusEl.textContent = ''
  showWarning(message)
})

window.flowReview.onCopied(() => {
  statusEl.textContent = 'Copied.'
  setTimeout(() => {
    statusEl.textContent = ''
  }, 2000)
})

document.getElementById('btn-insert').addEventListener('click', () => {
  statusEl.textContent = 'Inserting…'
  window.flowReview.insert(textarea.value)
})
document.getElementById('btn-copy').addEventListener('click', () => {
  window.flowReview.copy(textarea.value)
})
document.getElementById('btn-retry').addEventListener('click', () => window.flowReview.retry())
document.getElementById('btn-cancel').addEventListener('click', () => window.flowReview.cancel())

// Ctrl+Enter inside the textarea submits (plain Enter stays a newline, since a
// dictated transcript may legitimately span multiple lines).
textarea.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault()
    document.getElementById('btn-insert').click()
  }
})

// Window-level shortcuts. Ctrl+Shift+C / Ctrl+Shift+R are used (rather than
// the plain Ctrl+C / Ctrl+R a user might expect) specifically to avoid
// clashing with native copy and any reload-like default behavior.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    window.flowReview.cancel()
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'c') {
    e.preventDefault()
    window.flowReview.copy(textarea.value)
  } else if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'r') {
    e.preventDefault()
    window.flowReview.retry()
  }
})
