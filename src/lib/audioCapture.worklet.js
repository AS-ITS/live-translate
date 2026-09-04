class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.processCount = 0;
  }

  process(inputs) {
    this.processCount += 1;
    const input = inputs[0]?.[0];

    if (input) {
      const samples = input.slice();
      this.port.postMessage({
        type: 'pcm',
        processCount: this.processCount,
        samples: samples.buffer
      }, [samples.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
