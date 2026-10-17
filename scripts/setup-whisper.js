// Downloads the prebuilt whisper.cpp CPU binary (Windows x64) and the base.en
// ggml model into bin/whisper and models/, if they aren't already present.
// Safe to re-run: skips any file that already exists.
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const https = require('node:https')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const BIN_DIR = path.join(ROOT, 'bin', 'whisper')
const MODELS_DIR = path.join(ROOT, 'models')
const WHISPER_EXE = path.join(BIN_DIR, 'whisper-cli.exe')
const MODEL_FILE = path.join(MODELS_DIR, 'ggml-base.en.bin')

const WHISPER_ZIP_URL = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip'
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'

function download(url, destFile) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destFile)
    const request = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close()
          return request(res.headers.location)
        }
        if (res.statusCode !== 200) {
          reject(new Error(`Download failed (${res.statusCode}) for ${u}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(resolve))
      }).on('error', reject)
    }
    request(url)
  })
}

async function main() {
  fs.mkdirSync(BIN_DIR, { recursive: true })
  fs.mkdirSync(MODELS_DIR, { recursive: true })

  if (!fs.existsSync(WHISPER_EXE)) {
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

  if (!fs.existsSync(MODEL_FILE)) {
    console.log('Downloading ggml-base.en.bin model (~148MB)...')
    await download(MODEL_URL, MODEL_FILE)
    console.log('Model ready.')
  } else {
    console.log('Model already present, skipping.')
  }

  console.log('Setup complete.')
}

main().catch((err) => {
  console.error('Setup failed:', err.message)
  process.exit(1)
})
