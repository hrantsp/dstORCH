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

// Resolved once, at load, rather than inside the handshake. An exception thrown while
// building this string would kill the open handler before hello was ever sent, leaving
// a connected socket that says nothing — which looks like the desktop app hanging.
const CLIENT = (() => {
  try {
    return `Verbal/${chrome.runtime.getManifest().version}`;
  } catch {
    return 'Verbal/unknown';
  }
})();

const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 10000;

let context = null;
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
  // Audio only goes to a link that has completed its handshake. Sending on one that
  // has not is a protocol violation, and the server is right to close on it.
  if (!link || !link.ready || link.ws.readyState !== WebSocket.OPEN) return;
  if (!openStreams.has(streamId)) return;

  if (link.ws.bufferedAmount > MAX_BUFFERED_BYTES) {
    dropped[streamId] += 1;
    return;
  }

  link.ws.send(encodeFrame(streamId, sampleIndex, samples));
}

// ── transport ────────────────────────────────────────────────────────────────

// One connection and its state, replaced as a whole on every reconnect.
//
// Every handler below closes over its own `current` rather than reading a shared
// variable. Reading a shared one meant that after a reconnect, an older socket's
// handler would act on the newer socket — which is how `bye` was sent as the first
// message on a connection that had never said `hello`, and got the session rejected.
let link = null;

function closeLink() {
  if (!link) return;
  const closing = link;
  link = null;
  try {
    closing.ws.close();
  } catch {
    // Already closing or closed; nothing to do.
  }
}

function connect() {
  if (stopping) return;

  // Explicitly, rather than by reassignment: an abandoned socket keeps its listeners
  // and its place in the event queue.
  closeLink();

  const current = { ws: new WebSocket(`ws://127.0.0.1:${config.port}`), ready: false };
  current.ws.binaryType = 'arraybuffer';
  link = current;

  current.ws.addEventListener('open', () => {
    if (link !== current) return; // superseded while connecting

    // Guarded, because anything thrown here is thrown inside an event handler: the
    // socket stays open, the handshake never happens, and the failure is invisible
    // from both ends. Reporting it is the difference between a bug and a mystery.
    try {
      current.ws.send(control.hello(contextEpochUtcMs, config.token, CLIENT));
    } catch (err) {
      report('error', `Could not send the handshake: ${err?.message ?? err}`);
      closeLink();
    }
  });

  current.ws.addEventListener('message', (event) => {
    if (link !== current) return;

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

    current.ready = true;
    reconnectDelay = RECONNECT_MIN_MS;

    for (const streamId of [STREAM.MIC, STREAM.TAB]) {
      current.ws.send(control.streamOpen(streamId));
      openStreams.add(streamId);
    }

    report('capturing', `Streaming to Kobayashi on port ${config.port}`);
  });

  current.ws.addEventListener('close', () => {
    if (link !== current) return; // a superseded socket closing is not news
    link = null;
    openStreams.clear();
    if (stopping) return;

    report('reconnecting', `Lost the desktop app, retrying in ${reconnectDelay} ms`);
    scheduleReconnect();
  });

  current.ws.addEventListener('error', () => {
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

  // Only a link that handshook can be said goodbye to. Saying it on one that never
  // sent hello is exactly the violation that was being rejected.
  if (link && link.ready && link.ws.readyState === WebSocket.OPEN) {
    for (const streamId of openStreams) {
      link.ws.send(control.streamClose(streamId, 'user-stopped'));
    }
    link.ws.send(control.bye());
  }

  const lost = dropped[STREAM.MIC] + dropped[STREAM.TAB];
  await teardown();
  report('stopped', lost > 0 ? `Stopped. ${lost} frames dropped under backpressure.` : 'Stopped.');
}

async function teardown() {
  openStreams.clear();

  closeLink();

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
