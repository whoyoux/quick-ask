// Runs on the audio thread: forwards raw microphone samples to the recorder.
class PcmCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) this.port.postMessage(channel.slice(0))
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
