// Runs on the audio thread. One instance per stream.
//
// Deliberately dependency-free: an AudioWorklet module is loaded into its own global
// scope, so keeping it self-contained avoids relying on module resolution inside that
// scope. Everything it needs arrives through processorOptions.
//
// The only thing this does beyond buffering is read `currentFrame`, which is the
// reason the whole timing model works. It is a counter belonging to the AudioContext,
// not to this node, so both capture taps read the same clock in the same render pass.
// Two frames stamped with the same index were captured at the same instant by
// construction rather than by measurement.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const { frameSamples } = options.processorOptions;
    this.frameSamples = frameSamples;

    this.buffer = new Int16Array(frameSamples);
    this.filled = 0;

    // Sample position of buffer[0] on the shared clock, captured when a frame starts.
    this.frameStart = 0;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];

    // No input connected yet, or the source ended. Returning true keeps this
    // processor alive rather than letting the graph drop it.
    if (!channel) return true;

    for (let ii = 0; ii < channel.length; ++ii) {
      if (this.filled === 0) {
        // currentFrame is the index of the first sample of the current render
        // quantum, so the offset within it gives this sample's exact position.
        this.frameStart = currentFrame + ii;
      }

      // Clamp before scaling: a sample outside [-1, 1] would wrap around and become
      // a loud click rather than clipping quietly.
      const value = Math.max(-1, Math.min(1, channel[ii]));
      this.buffer[this.filled++] = Math.round(value * 32767);

      if (this.filled === this.frameSamples) {
        // Transfer rather than copy — this runs on the audio thread, and every
        // avoidable allocation here is a chance to glitch.
        const samples = this.buffer;
        this.port.postMessage({ sampleIndex: this.frameStart, samples }, [samples.buffer]);

        this.buffer = new Int16Array(this.frameSamples);
        this.filled = 0;
      }
    }

    return true;
  }
}

registerProcessor('dst-capture', CaptureProcessor);
