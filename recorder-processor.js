// AudioWorkletProcessor that batches raw mic samples into fixed-size chunks
// and posts each one to the main thread as it fills, so audio is streamed
// off the audio thread continuously instead of waiting for the whole
// recording to finish (MediaRecorder-style).
class DictationRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.chunkSize = 4096
    this.buffer = new Float32Array(this.chunkSize)
    this.writeIndex = 0

    this.port.onmessage = (event) => {
      if (event.data !== 'flush') return
      if (this.writeIndex > 0) {
        this.port.postMessage(this.buffer.slice(0, this.writeIndex))
        this.writeIndex = 0
      }
      // Sentinel so the main thread can wait for the flushed chunk to be
      // handled (and forwarded over IPC) instead of guessing with a timer —
      // 'flushed' is only posted after the data chunk above, and this port
      // delivers messages in order, so its arrival proves the chunk already did.
      this.port.postMessage('flushed')
    }
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true

    for (let i = 0; i < channel.length; i++) {
      this.buffer[this.writeIndex++] = channel[i]
      if (this.writeIndex === this.chunkSize) {
        this.port.postMessage(this.buffer.slice())
        this.writeIndex = 0
      }
    }
    return true
  }
}

registerProcessor('dictation-recorder', DictationRecorderProcessor)
