// Downloads the prebuilt whisper.cpp CPU binary (Windows x64) and the base.en
// ggml model into bin/whisper and models/, if they aren't already present.
// Safe to re-run: skips any file that already exists.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { pipeline } = require('node:stream/promises')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const BIN_DIR = path.join(ROOT, 'bin', 'whisper')
const MODELS_DIR = path.join(ROOT, 'models')
const WHISPER_EXE = path.join(BIN_DIR, 'whisper-cli.exe')
const MODEL_FILE = path.join(MODELS_DIR, 'ggml-base.en.bin')

const WHISPER_ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'

const MAX_REDIRECTS = 10
const IDLE_TIMEOUT_MS = 30_000

// Resolves with the final 200 response, following redirects. Each redirect's
// body is discarded, and no file is opened until the real content arrives —
// the old version opened the file up front and closed it on the first
// redirect, so the redirected body was piped into a closed stream and the
// download produced an empty file and hung.
function fetchFollowingRedirects(url, redirectsLeft = MAX_REDIRECTS) {
  return new Promise((resolve, reject) => {
    const current = new URL(url)
    const client = current.protocol === 'https:' ? https : current.protocol === 'http:' ? http : null
    if (!client) {
      reject(new Error(`Unsupported protocol in ${url}`))
      return
    }

    const req = client.get(current, (res) => {
      const { statusCode } = res
      if (statusCode >= 300 && statusCode < 400 && res.headers.location) {
        res.resume()
        if (redirectsLeft === 0) {
          reject(new Error(`Too many redirects for ${url}`))
          return
        }
        // Location may be relative (Hugging Face sends relative ones).
        const next = new URL(res.headers.location, current)
        if (current.protocol === 'https:' && next.protocol !== 'https:') {
          reject(new Error(`Refusing to follow a redirect from https to ${next.protocol} (${next.href})`))
          return
        }
        resolve(fetchFollowingRedirects(next.href, redirectsLeft - 1))
        return
      }
      if (statusCode !== 200) {
        res.resume()
        reject(new Error(`Download failed (HTTP ${statusCode}) for ${url}`))
        return
      }
      resolve(res)
    })

    // Fails a stalled connection instead of hanging forever.
    req.setTimeout(IDLE_TIMEOUT_MS, () => {
      req.destroy(new Error(`No data for ${IDLE_TIMEOUT_MS / 1000}s from ${url}`))
    })
    req.on('error', reject)
  })
}

// Streams url into destFile. The data goes to destFile + '.part' first and is
// only renamed into place once the transfer finished and matched the
// server's Content-Length, so a failed or interrupted download never leaves a
// file at destFile that the "already present" checks would treat as valid.
async function download(url, destFile) {
  const partFile = `${destFile}.part`
  try {
    const res = await fetchFollowingRedirects(url)
    const expected = Number(res.headers['content-length'])
    let received = 0
    res.on('data', (chunk) => {
      received += chunk.length
    })

    // pipeline() closes the file and rejects if either side errors, including
    // a connection that drops mid-transfer.
    await pipeline(res, fs.createWriteStream(partFile))

    if (Number.isFinite(expected) && expected > 0 && received !== expected) {
      throw new Error(`Incomplete download for ${url}: got ${received} of ${expected} bytes`)
    }
    if (received === 0) {
      throw new Error(`Empty download for ${url}`)
    }
    fs.renameSync(partFile, destFile)
  } catch (err) {
    fs.rmSync(partFile, { force: true })
    throw err
  }
}

// A zero-byte file is what the old, broken download left behind, so treat it
// as missing rather than skipping the download.
function isPresent(file) {
  try {
    return fs.statSync(file).size > 0
  } catch {
    return false
  }
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true })
  fs.mkdirSync(MODELS_DIR, { recursive: true })

  if (!isPresent(WHISPER_EXE)) {
    console.log('Downloading whisper.cpp (Windows x64 CPU build, ~9MB)...')
    const zipPath = path.join(BIN_DIR, '_whisper-bin-x64.zip')
    await download(WHISPER_ZIP_URL, zipPath)
    console.log('Extracting...')
    // tar supports .zip extraction on modern Windows/Node toolchains.
    execFileSync('tar', ['-xf', zipPath, '-C', BIN_DIR])
    fs.rmSync(zipPath)
    // The zip extracts into a "Release" subfolder; flatten it into bin/whisper.
    const releaseDir = path.join(BIN_DIR, 'Release')
    if (fs.existsSync(releaseDir)) {
      for (const entry of fs.readdirSync(releaseDir)) {
        fs.renameSync(path.join(releaseDir, entry), path.join(BIN_DIR, entry))
      }
      fs.rmdirSync(releaseDir)
    }
    console.log('whisper.cpp binary ready.')
  } else {
    console.log('whisper-cli.exe already present, skipping.')
  }

  if (!isPresent(MODEL_FILE)) {
    console.log('Downloading ggml-base.en.bin model (~148MB)...')
    await download(MODEL_URL, MODEL_FILE)
    console.log('Model ready.')
  } else {
    console.log('Model already present, skipping.')
  }

  console.log('Setup complete.')
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Setup failed:', err.message)
    process.exit(1)
  })
}

module.exports = { download }
