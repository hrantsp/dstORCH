// Encoding of the dst wire protocol.
//
// The normative specification and the constants below both come from dstDESK, which
// owns the protocol — see rec/PROTOCOL.md there. Nothing in this file decides
// anything; it only lays bytes out in the order the server expects.
//
// Deliberately free of any browser API, so the same code runs under Node in
// tst/wire-check.mjs. That check talks to a real Kobayashi, which is what proves the
// encoder agrees with the C++ parser byte for byte.

import {
  VERSION,
  SAMPLE_RATE,
  FRAME_SAMPLES,
  HEADER_BYTES,
  OFFSET,
  LITTLE_ENDIAN,
  STREAM_LABEL,
} from './generated/protocol.js';

/**
 * Lays out one binary audio frame: a fixed header followed by signed 16-bit samples.
 *
 * @param {number} stream       STREAM.MIC or STREAM.TAB
 * @param {number} sampleIndex  position on the capture clock shared by both streams
 * @param {Int16Array} samples
 * @returns {ArrayBuffer} ready to hand to WebSocket.send
 */
export function encodeFrame(stream, sampleIndex, samples) {
  const buffer = new ArrayBuffer(HEADER_BYTES + samples.length * 2);
  const view = new DataView(buffer);

  view.setUint8(OFFSET.version, VERSION);
  view.setUint8(OFFSET.stream, stream);
  view.setUint16(OFFSET.frameSamples, samples.length, LITTLE_ENDIAN);

  // >>> 0 keeps the value unsigned: sampleIndex is a u32 on the wire, and JavaScript
  // bitwise operations would otherwise hand back a negative number past 2^31.
  view.setUint32(OFFSET.sampleIndex, sampleIndex >>> 0, LITTLE_ENDIAN);
  view.setUint32(OFFSET.flags, 0, LITTLE_ENDIAN);

  // The header length is even precisely so this view is legal — an odd header would
  // misalign every sample. See PROTOCOL.md §5.1.
  new Int16Array(buffer, HEADER_BYTES).set(samples);

  return buffer;
}

/** Control messages travel as text frames on the same socket. PROTOCOL.md §4. */
export const control = {
  hello(contextEpochUtcMs, token, client) {
    const message = {
      type: 'hello',
      protocol: VERSION,
      sampleRate: SAMPLE_RATE,
      frameSamples: FRAME_SAMPLES,
      contextEpochUtcMs,
      client,
    };
    if (token) message.token = token;
    return JSON.stringify(message);
  },

  streamOpen(stream) {
    return JSON.stringify({
      type: 'stream-open',
      stream,
      label: STREAM_LABEL[stream],
    });
  },

  streamClose(stream, reason) {
    return JSON.stringify({ type: 'stream-close', stream, reason });
  },

  bye() {
    return JSON.stringify({ type: 'bye' });
  },
};

/**
 * Converts a worklet's Float32 samples to the signed 16-bit the wire carries.
 * Clamped, because a sample outside [-1, 1] would wrap and become a loud click.
 */
export function toPcm16(input, output) {
  for (let ii = 0; ii < input.length; ++ii) {
    const clamped = Math.max(-1, Math.min(1, input[ii]));
    output[ii] = Math.round(clamped * 32767);
  }
  return output;
}
