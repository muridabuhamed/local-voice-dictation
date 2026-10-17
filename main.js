const { app, BrowserWindow, globalShortcut, ipcMain, clipboard, screen } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const execFileAsync = promisify(execFile)

const DEFAULT_HOTKEY = 'Control+Alt+Space'
const WHISPER_EXE = path.join(__dirname, 'bin', 'whisper', 'whisper-cli.exe')
const WHISPER_MODEL = path.join(__dirname, 'models', 'ggml-base.en.bin')
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json')
const HISTORY_FILE = path.join(app.getPath('userData'), 'history.json')
const MAX_HISTORY_ENTRIES = 200

// ---- settings -------------------------------------------------------------

function loadSettings() {
  const defaults = { hotkey: DEFAULT_HOTKEY, reviewMode: false }
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'))
    return { ...defaults, ...saved }
  } catch {
    return defaults
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true })
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2))
}

let settings = loadSettings()

// ---- local whisper.cpp transcription ---------------------------------------

function whisperReady() {
  return fs.existsSync(WHISPER_EXE) && fs.existsSync(WHISPER_MODEL)
}

// Builds a minimal 16-bit PCM mono WAV file from raw little-endian Int16 samples.
function encodeWav(pcmBuffer, sampleRate) {
  const header = Buffer.alloc(44)
  const dataSize = pcmBuffer.length
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataSize, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate (16-bit mono)
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataSize, 40)
  return Buffer.concat([header, pcmBuffer])
}

async function transcribeWav(wavPath) {
  const { stdout } = await execFileAsync(
    WHISPER_EXE,
    ['-m', WHISPER_MODEL, '-f', wavPath, '--no-timestamps', '--language', 'en'],
    { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 },
  )
  return stdout.trim()
}

// ---- target window capture / validation (Windows Win32 via PowerShell) -----
//
// Electron has no cross-platform API for "what window had focus before mine
// reacted" or "make that specific window foreground again", so this talks to
// user32.dll directly through short-lived PowerShell helper processes — the
// same approach already used for the paste keystroke, no new dependency.

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function runPowerShell(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) reject(err)
        else resolve(stdout)
      },
    )
  })
}

// Declared once per script invocation (each runPowerShell call is a fresh
// process, so redefining this class every time is fine — no Add-Type clash).
const WIN32_HELPER = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FlowCloneWin32 {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
}
'@
`.trim()

// Read-only: reports the current foreground window. Sends no input and
// changes nothing, so this is safe to call purely to observe state.
async function captureForegroundWindow() {
  const script = `${WIN32_HELPER}
$h = [FlowCloneWin32]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[FlowCloneWin32]::GetWindowText($h, $sb, 512) | Out-Null
$pid = 0
[FlowCloneWin32]::GetWindowThreadProcessId($h, [ref]$pid) | Out-Null
Write-Output "$($h.ToInt64())|$pid|$($sb.ToString())"`
  const out = (await runPowerShell(script)).trim()
  const [hwnd, pidStr, ...titleParts] = out.split('|')
  if (!hwnd || hwnd === '0') return null
  return { hwnd, pid: Number(pidStr), title: titleParts.join('|') }
}

// Returns the decimal HWND strings of our own windows, so a captured target
// can be rejected if it's actually this app (e.g. the user was focused on the
// settings panel when they pressed the hotkey).
function ownWindowHandles() {
  const handles = []
  for (const w of [dashboardWin, reviewWin, pillWin]) {
    if (w && !w.isDestroyed()) {
      try {
        // HWNDs in practice are small positive values, so the signed Int64
        // string PowerShell produces (ToInt64()) and this unsigned-UInt64
        // string agree — verified during manual testing.
        handles.push(w.getNativeWindowHandle().readBigUInt64LE(0).toString())
      } catch {
        // Window may be mid-construction; skip rather than fail the guard.
      }
    }
  }
  return handles
}

// Confirms the target still exists, then actively brings it back to the real
// OS foreground and verifies that actually happened — never assumes whatever
// currently has focus is correct. The empty SendKeys resets Windows' foreground
// -lock timeout so SetForegroundWindow is honored instead of silently ignored
// (confirmed necessary via instrumented testing: without it, a background
// process's SetForegroundWindow call is frequently ignored by Windows).
async function focusTarget(target) {
  if (!target) return { ok: false, reason: 'no-target' }
  const script = `${WIN32_HELPER}
Add-Type -AssemblyName System.Windows.Forms
$target = [IntPtr]${target.hwnd}
if (-not [FlowCloneWin32]::IsWindow($target)) { Write-Output "CLOSED"; exit }
[System.Windows.Forms.SendKeys]::SendWait("")
Start-Sleep -Milliseconds 80
[FlowCloneWin32]::SetForegroundWindow($target) | Out-Null
Start-Sleep -Milliseconds 150
$current = [FlowCloneWin32]::GetForegroundWindow()
if ($current.Equals($target)) { Write-Output "OK" } else { Write-Output "FOCUS_FAILED" }`
  let out
  try {
    out = (await runPowerShell(script)).trim()
  } catch (err) {
    return { ok: false, reason: 'helper-error' }
  }
  if (out === 'OK') return { ok: true }
  if (out === 'CLOSED') return { ok: false, reason: 'closed' }
  return { ok: false, reason: 'focus-failed' }
}

// ---- clipboard-paste text insertion ----------------------------------------

function sendPasteKeystroke() {
  return new Promise((resolve, reject) => {
    const script =
      "$wshell = New-Object -ComObject wscript.shell; Start-Sleep -Milliseconds 150; $wshell.SendKeys('^v')"
    // windowsHide matters here, not just for tidiness: a visible console window
    // for this helper process can itself grab OS foreground focus away from the
    // target app for the brief moment it exists, misdirecting the paste.
    // Confirmed via instrumented GetForegroundWindow checks during testing.
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true },
      (err) => {
        if (err) reject(err)
        else resolve()
      },
    )
  })
}

// Throws a TARGET_UNAVAILABLE error (instead of pasting blind) if the
// captured target can't be confirmed as the real foreground window first.
async function pasteText(text, target) {
  const focusResult = await focusTarget(target)
  if (!focusResult.ok) {
    const err = new Error(`Target window unavailable (${focusResult.reason})`)
    err.code = 'TARGET_UNAVAILABLE'
    throw err
  }

  let previousClipboard = null
  try {
    previousClipboard = clipboard.readText()
  } catch {
    previousClipboard = null
  }

  clipboard.writeText(text)
  try {
    await sendPasteKeystroke()
  } finally {
    // Give the target app time to read the clipboard before we restore it.
    await delay(500)
    try {
      if (previousClipboard !== null) clipboard.writeText(previousClipboard)
    } catch {
      // Non-fatal: the dictated text simply stays on the clipboard.
    }
  }
}

// ---- dictation history (real, derived from actual usage — never fabricated) -

function loadHistory() {
  try {
    const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'))
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

function saveHistory() {
  try {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true })
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2))
  } catch (err) {
    console.error('Could not save history:', err.message)
  }
}

let history = loadHistory()
let historyIdCounter = history.reduce((max, e) => Math.max(max, e.id || 0), 0)

function wordCountOf(text) {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

// status: 'pasted' | 'copied' | 'cancelled' | 'error'
function addHistoryEntry({ text, durationMs, status }) {
  const entry = {
    id: ++historyIdCounter,
    timestamp: Date.now(),
    text,
    wordCount: wordCountOf(text),
    durationMs: durationMs || 0,
    status,
  }
  history.unshift(entry)
  if (history.length > MAX_HISTORY_ENTRIES) history.length = MAX_HISTORY_ENTRIES
  saveHistory()
  broadcastHistory()
  return entry
}

// Every number here is derived from real logged entries — zero placeholders.
function computeStats() {
  const totalWords = history.reduce((sum, e) => sum + (e.wordCount || 0), 0)

  const timed = history.filter((e) => e.durationMs > 0 && e.wordCount > 0)
  const totalMs = timed.reduce((s, e) => s + e.durationMs, 0)
  const timedWords = timed.reduce((s, e) => s + e.wordCount, 0)
  const wpm = totalMs > 0 ? Math.round(timedWords / (totalMs / 60000)) : 0

  const days = new Set(history.map((e) => new Date(e.timestamp).toDateString()))
  let streak = 0
  const cursor = new Date()
  while (days.has(cursor.toDateString())) {
    streak++
    cursor.setDate(cursor.getDate() - 1)
  }

  return { totalWords, wpm, streak }
}

function broadcastHistory() {
  dashboardWin?.webContents.send('history-update', { entries: history, stats: computeStats() })
}

// ---- window + lifecycle ----------------------------------------------------

let dashboardWin
let pillWin = null
let reviewWin = null
let pendingReview = null // { text, target, targetUnavailable, durationMs } while the review window is open
let state = 'idle' // idle | recording | processing | success | error | reviewing
let currentChunks = []
let currentSampleRate = 16000
let isRecordingSession = false
let isCapturingTarget = false
let capturedTarget = null // { hwnd, pid, title } snapshotted at recording start

function createDashboardWindow() {
  dashboardWin = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#eeece5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  dashboardWin.loadFile('renderer.html')
  dashboardWin.on('maximize', () => dashboardWin.webContents.send('window-maximized', true))
  dashboardWin.on('unmaximize', () => dashboardWin.webContents.send('window-maximized', false))
}

// Small always-on-top indicator shown only while a dictation is actively in
// flight, so the hotkey-from-anywhere workflow doesn't require the (now much
// bigger, non-always-on-top) dashboard to be open or visible.
function createPillWindow() {
  if (pillWin && !pillWin.isDestroyed()) return
  pillWin = new BrowserWindow({
    width: 240,
    height: 56,
    resizable: false,
    alwaysOnTop: true,
    frame: false,
    transparent: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'pill-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  pillWin.loadFile('status-pill.html')
  pillWin.webContents.once('did-finish-load', () => {
    try {
      const { width } = screen.getPrimaryDisplay().workAreaSize
      const bounds = pillWin.getBounds()
      pillWin.setPosition(Math.round((width - bounds.width) / 2), 36)
    } catch {
      // Non-fatal — the window just keeps its default position.
    }
  })
  pillWin.on('closed', () => {
    pillWin = null
  })
}

function openReviewWindow(text, target, opts = {}) {
  pendingReview = {
    text,
    target,
    targetUnavailable: !!opts.targetUnavailable,
    durationMs: opts.durationMs || 0,
  }
  setState('reviewing')

  if (reviewWin && !reviewWin.isDestroyed()) {
    reviewWin.webContents.send('review-data', pendingReview)
    reviewWin.focus()
    return
  }

  reviewWin = new BrowserWindow({
    width: 480,
    height: 380,
    title: 'Review Transcript — Flow Clone',
    resizable: true,
    backgroundColor: '#eeece5',
    webPreferences: {
      preload: path.join(__dirname, 'review-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  reviewWin.setMenu(null)
  reviewWin.loadFile('review.html')
  reviewWin.webContents.once('did-finish-load', () => {
    reviewWin?.webContents.send('review-data', pendingReview)
  })
  reviewWin.on('closed', () => {
    reviewWin = null
    // Only true if the window was closed via its native X/Alt+F4 rather than
    // through one of our own handlers (which already clear pendingReview
    // before calling .close(), so this won't clobber a state they already set).
    if (pendingReview) {
      addHistoryEntry({ text: pendingReview.text, durationMs: pendingReview.durationMs, status: 'cancelled' })
      pendingReview = null
      setState('idle')
    }
  })
}

function setState(next, message = '', transcript = null) {
  state = next
  console.log(`[state] ${next}${message ? ' — ' + message : ''}`)
  dashboardWin?.webContents.send('state', { state, message, transcript })

  if (next === 'recording' || next === 'processing') {
    createPillWindow()
    pillWin?.webContents.send('state', { state, message, transcript })
    // showInactive(): visible feedback without taking keyboard focus away
    // from whatever the user is dictating into.
    pillWin?.showInactive()
  } else if (next === 'success' || next === 'error') {
    pillWin?.webContents.send('state', { state, message, transcript })
    pillWin?.showInactive()
    const hideAfter = next === 'success' ? 1800 : 3200
    setTimeout(() => {
      if (state === next) pillWin?.hide()
    }, hideAfter)
  } else {
    pillWin?.hide()
  }
}

function registerHotkey(accelerator) {
  globalShortcut.unregisterAll()
  const ok = globalShortcut.register(accelerator, onHotkey)
  return ok
}

// Shared by the hotkey's start-recording branch and the review window's Retry
// button — both need a *fresh* target capture, since the user may have
// switched windows while a previous transcript was being reviewed.
async function startRecordingFlow() {
  if (!whisperReady()) {
    setState('error', 'Local speech model not installed. Run: npm run setup')
    setTimeout(() => setState('idle'), 5000)
    return
  }

  isCapturingTarget = true
  let target
  try {
    target = await captureForegroundWindow()
  } finally {
    isCapturingTarget = false
  }

  if (!target || ownWindowHandles().includes(target.hwnd)) {
    setState('error', 'Focus the window you want to dictate into, then press the hotkey again.')
    setTimeout(() => setState('idle'), 4000)
    return
  }

  capturedTarget = target
  isRecordingSession = true
  currentChunks = []
  setState('recording')
  dashboardWin?.webContents.send('start-recording')
}

function onHotkey() {
  if (reviewWin && !reviewWin.isDestroyed()) {
    // A transcript is already waiting on a decision — bring it to the user's
    // attention instead of silently starting (and losing) another recording.
    reviewWin.focus()
    return
  }
  if (isCapturingTarget) return // a start is already in flight; ignore the re-entrant press

  if (state === 'idle' || state === 'success' || state === 'error') {
    startRecordingFlow()
  } else if (state === 'recording') {
    dashboardWin?.webContents.send('stop-recording')
  }
  // Ignore the hotkey while 'processing' so a dictation can't be interrupted mid-transcription.
}

// ---- IPC --------------------------------------------------------------------

ipcMain.on('mic-error', (_event, payload) => {
  isRecordingSession = false
  const name = typeof payload?.name === 'string' ? payload.name : 'UnknownError'
  const message = typeof payload?.message === 'string' ? payload.message : ''
  const friendly =
    name === 'NotAllowedError'
      ? 'Microphone access denied. Enable it in Windows Settings > Privacy > Microphone.'
      : name === 'NotFoundError'
        ? 'No microphone found.'
        : `Microphone error: ${message || name}`
  setState('error', friendly)
  setTimeout(() => setState('idle'), 4000)
})

ipcMain.on('recording-config', (_event, payload) => {
  const sampleRate = Number(payload?.sampleRate)
  currentSampleRate = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 16000
})

ipcMain.on('audio-chunk', (_event, floatArrayBuffer) => {
  if (!isRecordingSession) return
  try {
    const floatSamples = new Float32Array(floatArrayBuffer)
    const pcm16 = Buffer.alloc(floatSamples.length * 2)
    for (let i = 0; i < floatSamples.length; i++) {
      const s = Math.max(-1, Math.min(1, floatSamples[i]))
      pcm16.writeInt16LE(s < 0 ? s * 0x8000 : s * 0x7fff, i * 2)
    }
    currentChunks.push(pcm16)
  } catch (err) {
    // A malformed chunk shouldn't take down the whole app mid-recording —
    // drop it and keep going; worst case this dictation's transcript is short.
    console.error('Dropped malformed audio chunk:', err.message)
  }
})

ipcMain.on('recording-stopped', async () => {
  isRecordingSession = false
  setState('processing')

  const pcmBuffer = Buffer.concat(currentChunks)
  currentChunks = []
  const target = capturedTarget // snapshot — a new recording can't start until this one resolves
  const durationMs = Math.round((pcmBuffer.length / 2 / currentSampleRate) * 1000)

  if (pcmBuffer.length < currentSampleRate * 0.2 * 2) {
    // Less than ~200ms of audio captured; not worth sending to the recognizer.
    setState('error', 'No speech detected.')
    setTimeout(() => setState('idle'), 3000)
    return
  }

  if (!whisperReady()) {
    setState('error', 'Local speech model not installed. Run: npm run setup')
    setTimeout(() => setState('idle'), 5000)
    return
  }

  const tmpWav = path.join(os.tmpdir(), `flow-clone-${Date.now()}.wav`)
  try {
    fs.writeFileSync(tmpWav, encodeWav(pcmBuffer, currentSampleRate))

    const rawText = await transcribeWav(tmpWav)
    if (!rawText) {
      setState('error', 'No speech detected.')
      setTimeout(() => setState('idle'), 3000)
      return
    }

    const finalText = rawText

    if (settings.reviewMode) {
      openReviewWindow(finalText, target, { durationMs })
      return
    }

    try {
      await pasteText(finalText, target)
      addHistoryEntry({ text: finalText, durationMs, status: 'pasted' })
      setState('success', 'Pasted', finalText)
      setTimeout(() => setState('idle'), 2500)
    } catch (err) {
      if (err.code === 'TARGET_UNAVAILABLE') {
        // Never lose the transcript to a focus failure — fall back to the
        // review window (which also offers Copy) instead of a blind paste.
        openReviewWindow(finalText, target, { targetUnavailable: true, durationMs })
      } else {
        console.error('Paste failed:', err.message)
        addHistoryEntry({ text: finalText, durationMs, status: 'error' })
        setState('error', 'Could not paste automatically — text is on your clipboard.', finalText)
        setTimeout(() => setState('idle'), 4500)
      }
    }
  } catch (err) {
    console.error('Transcription failed:', err.message)
    setState('error', 'Local transcription failed.')
    setTimeout(() => setState('idle'), 4000)
  } finally {
    try {
      fs.unlinkSync(tmpWav)
    } catch {
      // best-effort cleanup
    }
  }
})

// ---- review window IPC -------------------------------------------------------

ipcMain.handle('review-get-data', () => pendingReview)

ipcMain.on('review-insert', async (_event, editedText) => {
  if (typeof editedText !== 'string' || !editedText.trim() || !pendingReview) return
  const { target, durationMs } = pendingReview
  try {
    await pasteText(editedText, target)
    addHistoryEntry({ text: editedText, durationMs, status: 'pasted' })
    pendingReview = null
    reviewWin?.close()
    setState('success', 'Pasted', editedText)
    setTimeout(() => setState('idle'), 2500)
  } catch (err) {
    clipboard.writeText(editedText)
    reviewWin?.webContents.send(
      'review-insert-failed',
      err.code === 'TARGET_UNAVAILABLE'
        ? 'Original window is no longer available. Text copied to clipboard — click into your target app, then try Insert again or paste manually.'
        : 'Could not paste automatically. Text copied to clipboard — paste manually.',
    )
  }
})

ipcMain.on('review-copy', (_event, text) => {
  if (typeof text !== 'string' || !pendingReview) return
  clipboard.writeText(text)
  addHistoryEntry({ text, durationMs: pendingReview.durationMs, status: 'copied' })
  reviewWin?.webContents.send('review-copied')
})

ipcMain.on('review-retry', async () => {
  if (pendingReview) {
    addHistoryEntry({ text: pendingReview.text, durationMs: pendingReview.durationMs, status: 'cancelled' })
  }
  pendingReview = null
  reviewWin?.close()
  await startRecordingFlow()
})

ipcMain.on('review-cancel', () => {
  if (pendingReview) {
    addHistoryEntry({ text: pendingReview.text, durationMs: pendingReview.durationMs, status: 'cancelled' })
  }
  pendingReview = null
  reviewWin?.close()
  setState('idle')
})

// ---- history IPC --------------------------------------------------------------

ipcMain.handle('get-history', () => ({ entries: history, stats: computeStats() }))

ipcMain.on('history-delete', (_event, id) => {
  const idx = history.findIndex((e) => e.id === id)
  if (idx === -1) return
  history.splice(idx, 1)
  saveHistory()
  broadcastHistory()
})

ipcMain.on('history-copy', (_event, id) => {
  const entry = history.find((e) => e.id === id)
  if (!entry) return
  clipboard.writeText(entry.text)
})

// Re-opens a past entry in the review window so it can be edited/inserted/
// copied again. There's no live target for an old entry, so Insert will go
// through the same TARGET_UNAVAILABLE path as any other stale-focus case.
ipcMain.on('history-recover', (_event, id) => {
  const entry = history.find((e) => e.id === id)
  if (!entry) return
  openReviewWindow(entry.text, null, { targetUnavailable: true, durationMs: entry.durationMs })
})

// ---- window chrome IPC (custom titlebar) --------------------------------------

ipcMain.on('win-minimize', () => dashboardWin?.minimize())
ipcMain.on('win-maximize-toggle', () => {
  if (!dashboardWin) return
  if (dashboardWin.isMaximized()) dashboardWin.unmaximize()
  else dashboardWin.maximize()
})
ipcMain.on('win-close', () => dashboardWin?.close())

// ---- settings IPC ---------------------------------------------------------------

ipcMain.handle('get-settings', () => ({
  ...settings,
  whisperReady: whisperReady(),
  osUsername: (() => {
    try {
      return os.userInfo().username
    } catch {
      return ''
    }
  })(),
}))

ipcMain.handle('save-settings', (_event, next) => {
  const candidateHotkey =
    typeof next?.hotkey === 'string' && next.hotkey.trim() ? next.hotkey.trim() : settings.hotkey
  const ok = registerHotkey(candidateHotkey)
  if (!ok) {
    // Revert to the previously working hotkey if the new one can't be registered.
    registerHotkey(settings.hotkey)
    return { ok: false, settings: { ...settings, whisperReady: whisperReady() } }
  }
  settings = {
    ...settings,
    hotkey: candidateHotkey,
    reviewMode: !!next?.reviewMode,
  }
  saveSettings(settings)
  return { ok: true, settings: { ...settings, whisperReady: whisperReady() } }
})

// ---- app lifecycle ------------------------------------------------------------

// If a previous run was killed mid-transcription, its temp WAV never got
// unlinked. These files are always single-use and named with our own prefix,
// so it's safe to sweep all of them on startup rather than tracking an age cutoff.
function cleanupOrphanedTempFiles() {
  try {
    for (const entry of fs.readdirSync(os.tmpdir())) {
      if (entry.startsWith('flow-clone-') && entry.endsWith('.wav')) {
        try {
          fs.unlinkSync(path.join(os.tmpdir(), entry))
        } catch {
          // Best-effort; another process may hold the file open.
        }
      }
    }
  } catch (err) {
    console.error('Could not sweep temp dir for orphaned WAV files:', err.message)
  }
}

app.whenReady().then(() => {
  cleanupOrphanedTempFiles()
  createDashboardWindow()
  const ok = registerHotkey(settings.hotkey)
  if (!ok) {
    console.error(`Could not register hotkey "${settings.hotkey}", falling back to default.`)
    settings.hotkey = DEFAULT_HOTKEY
    registerHotkey(DEFAULT_HOTKEY)
    saveSettings(settings)
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

app.on('window-all-closed', () => {
  app.quit()
})
