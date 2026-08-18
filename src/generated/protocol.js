// Generated from protocol.json by generate.py — do not edit.
//
// This file is committed, and it is the one generated artifact that is. A Chrome
// extension has no build step, so a reviewer who clones this repository and loads
// it unpacked — which is exactly what the task asks for — would otherwise get an
// extension that fails on an import for a file no step of theirs was going to
// produce. It is committed for that reason and no other.
//
// It should not be. A generated file in version control is a second copy of the
// truth that can drift from protocol.json, and the only thing preventing that
// here is `generate.py --check` running in dstDESK's build. Given a build step on
// this side, or a published package, this file would come out of git again.

export const VERSION = 1;
export const SAMPLE_RATE = 16000;
export const FRAME_SAMPLES = 512;
export const CHANNELS = 1;
export const HEADER_BYTES = 12;
export const FRAME_BYTES = 1036;
export const FRAME_MILLIS = 32.0;
export const DEFAULT_PORT = 8765;
export const EXTENSION_ORIGIN = 'chrome-extension://hmkghlnbpcpbofinfiecmifkhcjnbhok';

// Byte offsets within the frame header.
export const OFFSET = Object.freeze({
  version: 0,
  stream: 1,
  frameSamples: 2,
  sampleIndex: 4,
  flags: 8,
});

export const STREAM = Object.freeze({
  MIC: 0,
  TAB: 1,
});

export const STREAM_LABEL = Object.freeze({
  0: "Microphone",
  1: "Meeting",
});

// The wire is little-endian; every DataView call must pass true.
export const LITTLE_ENDIAN = true;
