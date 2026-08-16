// Capture and transmission.
//
// Both streams are fed into a single AudioContext, which is the decision the whole
// timing model rests on: they then share one clock, and cross-stream ordering is an
// integer comparison rather than a drift estimate. See decision 9 in dstOMNI/DESIGN.md.

import { encodeFrame, control } from './wire.js';
import { SAMPLE_RATE, FRAME_SAMPLES, STREAM, DEFAULT_PORT } from './generated/protocol.js';

// Above this, the socket is not keeping up and the newest frames are dropped rather
// than queued without limit. PROTOCOL.md §5.5 prefers losing old audio to unbounded
// growth, and sampleIndex makes the loss visible at the far end.
const MAX_BUFFERED_BYTES = 512 * 1024;

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10000;

let context = null;
let socket = null;
let monitor = null;

let micStream = null;
let tabStream = null;

let reconnectDelay = RECONNECT_MIN_MS;
let reconnectTimer = null;
let stopping = false;

let contextEpochUtcMs = 0;
let config = { port: DEFAULT_PORT, token: '' };

const openStreams = new Set();
const dropped = { [STREAM.MIC]: 0, [STREAM.TAB]: 0 };

function report(state, detail) {
  chrome.runtime.sendMessage({ type: 'status', state, detail }).catch(() => {
    // The service worker may be asleep. Status is advisory; capture continues.
  });
}

// ── audio graph ──────────────────────────────────────────────────────────────

// An offscreen document cannot raise a permission prompt: getUserMedia here fails
// immediately with NotAllowedError instead of asking. Detecting that up front lets the
// service worker open a page that *can* ask, rather than leaving the user to find the
// options page on their own.
async function microphoneGranted() {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state === 'granted';
  } catch {
    // If the query is unsupported, fall through and let getUserMedia decide.
    return true;
  }
}

async function buildGraph(streamId) {
  // 16 kHz is what the transcription engine wants, and Chrome resamples from the
  // device's native rate internally — so no resampler is needed here.
  context = new AudioContext({ sampleRate: SAMPLE_RATE });
  await context.audioWorklet.addModule('capture-worklet.js');

  // Maps AudioContext time zero onto the wall clock, so the desktop app can show
  // absolute times. Ordering never needs it.
  contextEpochUtcMs = Date.now() - context.currentTime * 1000;

  micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId,
      },
    },
  });

  // Capturing a tab silences it. Playing the captured stream back is what keeps the
  // user hearing their meeting — and it happens outside the capture graph, at the
  // stream's native rate. Routing it through the 16 kHz context would band-limit the
  // conversation to 8 kHz for the whole call. Decision 10.
  monitor = document.getElementById('monitor');
  monitor.srcObject = tabStream;
  await monitor.play().catch(() => report('warning', 'Could not restore tab playback'));

  tap(micStream, STREAM.MIC);
  tap(tabStream, STREAM.TAB);

  await context.resume();
}

function tap(stream, streamId) {
  const source = context.createMediaStreamSource(stream);

  const node = new AudioWorkletNode(context, 'dst-capture', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    processorOptions: { frameSamples: FRAME_SAMPLES },
  });

  node.port.onmessage = (event) => send(streamId, event.data);

  // A Web Audio node is only processed when it is connected towards the destination,
  // so a tap wired to nothing may never run at all. Routing through a silent gain
  // keeps it pulled without making a sound.
  const silence = context.createGain();
  silence.gain.value = 0;

  source.connect(node);
  node.connect(silence);
  silence.connect(context.destination);
}

function send(streamId, { sampleIndex, samples }) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  if (!openStreams.has(streamId)) return;

  if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
    dropped[streamId] += 1;
    return;
  }

  socket.send(encodeFrame(streamId, sampleIndex, samples));
}

// ── transport ────────────────────────────────────────────────────────────────

function connect() {
  if (stopping) return;

  socket = new WebSocket(`ws://127.0.0.1:${config.port}`);
  socket.binaryType = 'arraybuffer';

  socket.addEventListener('open', () => {
    // Read from the manifest rather than written here, so the handshake cannot
    // report a version the extension does not actually have.
    socket.send(control.hello(contextEpochUtcMs, config.token,
                              `dstORCH/${chrome.runtime.getManifest().version}`));
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }

    if (message.type === 'error') {
      // A rejected handshake is a configuration problem, not a transient one.
      // Retrying would produce an identical failure every few seconds.
      report('error', `${message.code}: ${message.message ?? ''}`);
      stop();
      return;
    }

    if (message.type !== 'ready') return;

    reconnectDelay = RECONNECT_MIN_MS;

    for (const streamId of [STREAM.MIC, STREAM.TAB]) {
      socket.send(control.streamOpen(streamId));
      openStreams.add(streamId);
    }

    report('capturing', `Streaming to dstDESK on port ${config.port}`);
  });

  socket.addEventListener('close', () => {
    openStreams.clear();
    if (stopping) return;

    report('reconnecting', `Lost the desktop app, retrying in ${reconnectDelay} ms`);
    scheduleReconnect();
  });

  socket.addEventListener('error', () => {
    // 'close' always follows, and handling both would double every message.
  });
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

// ── lifecycle ────────────────────────────────────────────────────────────────

async function start(streamId, options) {
  if (context) return; // already capturing

  stopping = false;
  config = { ...config, ...options };

  if (!(await microphoneGranted())) {
    report('needs-mic', 'Microphone access has not been granted yet');
    return;
  }

  try {
    await buildGraph(streamId);
  } catch (err) {
    if (err?.name === 'NotAllowedError') {
      // The permission was revoked between the check above and the call.
      report('needs-mic', 'Microphone access was refused');
      await teardown();
      return;
    }
    report('error', `${err?.name ?? 'Error'}: ${err?.message ?? err}`);
    await teardown();
    return;
  }

  connect();
}

async function stop() {
  stopping = true;
  clearTimeout(reconnectTimer);

  if (socket && socket.readyState === WebSocket.OPEN) {
    for (const streamId of openStreams) {
      socket.send(control.streamClose(streamId, 'user-stopped'));
    }
    socket.send(control.bye());
  }

  const lost = dropped[STREAM.MIC] + dropped[STREAM.TAB];
  await teardown();
  report('stopped', lost > 0 ? `Stopped. ${lost} frames dropped under backpressure.` : 'Stopped.');
}

async function teardown() {
  openStreams.clear();

  if (socket) {
    socket.close();
    socket = null;
  }

  for (const stream of [micStream, tabStream]) {
    stream?.getTracks().forEach((track) => track.stop());
  }
  micStream = null;
  tabStream = null;

  if (monitor) monitor.srcObject = null;

  if (context) {
    await context.close();
    context = null;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return false;

  if (message.type === 'start') {
    start(message.streamId, message.config).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === 'stop') {
    stop().then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});
