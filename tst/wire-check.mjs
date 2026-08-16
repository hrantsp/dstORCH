// Proves this repository's encoder produces bytes dstDESK's parser accepts.
//
// It imports src/wire.js unchanged — the same module the offscreen document uses —
// and drives a real socket against a running dstdesk. Chrome is not involved, so a
// wire-format disagreement can be found and fixed without loading an extension or
// joining a call.
//
//   Terminal 1:  dstDESK/bin/Release/dstdesk --output out
//   Terminal 2:  node dstORCH/tst/wire-check.mjs
//
// Exits non-zero on any failure, so it can be wired into a build later.

import { encodeFrame, control, toPcm16 } from '../src/wire.js';
import {
  SAMPLE_RATE,
  FRAME_SAMPLES,
  FRAME_BYTES,
  FRAME_MILLIS,
  DEFAULT_PORT,
  STREAM,
} from '../src/generated/protocol.js';

// Accepts both `--seconds 2` and `--seconds=2`. Supporting only one form and then
// silently reading the other as the string "true" is how a bad argument turns into
// NaN and surfaces later as an unrelated-looking failure.
function parseArgs(argv) {
  const out = new Map();
  for (let ii = 0; ii < argv.length; ++ii) {
    if (!argv[ii].startsWith('--')) continue;

    const [key, inline] = argv[ii].slice(2).split('=');
    if (inline !== undefined) {
      out.set(key, inline);
      continue;
    }

    const next = argv[ii + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out.set(key, next);
      ++ii;
    } else {
      out.set(key, 'true');
    }
  }
  return out;
}

function numberArg(args, name, fallback) {
  const raw = args.get(name);
  if (raw === undefined) return fallback;

  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    console.error(`Invalid --${name}: ${raw}`);
    process.exit(2);
  }
  return value;
}

const args = parseArgs(process.argv.slice(2));
const port = numberArg(args, 'port', DEFAULT_PORT);
const seconds = numberArg(args, 'seconds', 2);
const token = args.get('token') ?? '';

const frameCount = Math.floor((seconds * SAMPLE_RATE) / FRAME_SAMPLES);

// A stream's first sampleIndex is arbitrary: the shared capture clock has normally
// been running before either stream opens. Starting at a non-zero value keeps the
// check honest about that.
const startIndex = SAMPLE_RATE;

let failures = 0;

function check(label, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) ++failures;
}

// ── static checks, before any socket is opened ───────────────────────────────
console.log('Encoder:');

{
  const samples = new Int16Array(FRAME_SAMPLES);
  const buffer = encodeFrame(STREAM.MIC, 0, samples);
  check('frame size matches the generated constant', buffer.byteLength === FRAME_BYTES,
        `${buffer.byteLength} vs ${FRAME_BYTES}`);
}

{
  // Round-trips the header through a DataView the way the C++ side reads it.
  const samples = Int16Array.from([0, 1, -1, 32767, -32768]);
  const view = new DataView(encodeFrame(STREAM.TAB, 0xdeadbeef, samples));

  check('stream byte', view.getUint8(1) === STREAM.TAB);
  check('sample count', view.getUint16(2, true) === samples.length);
  check('sampleIndex survives past 2^31', view.getUint32(4, true) === 0xdeadbeef,
        `got ${view.getUint32(4, true)}`);

  const readBack = new Int16Array(view.buffer, 12, samples.length);
  check('samples round-trip including both extremes',
        readBack.every((vv, ii) => vv === samples[ii]));
}

{
  const out = new Int16Array(4);
  toPcm16(Float32Array.from([0, 1, -1, 2]), out);
  check('float conversion clamps rather than wrapping',
        out[1] === 32767 && out[2] === -32767 && out[3] === 32767,
        `[${out.join(', ')}]`);
}

if (failures > 0) {
  console.log(`\n${failures} encoder check(s) failed.`);
  process.exit(1);
}

// ── live check against a running dstdesk ─────────────────────────────────────
console.log(`\nConnecting to ws://127.0.0.1:${port}`);

const socket = new WebSocket(`ws://127.0.0.1:${port}`);
socket.binaryType = 'arraybuffer';

let sent = 0;
let timer = null;
let finished = false;

const watchdog = setTimeout(() => {
  fail('timed out with no response from the server');
}, (seconds + 10) * 1000);

function fail(reason) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (timer) clearInterval(timer);
  console.log(`  FAIL  ${reason}`);
  console.log('\nIs dstdesk running? Start it in another terminal first.');
  process.exit(1);
}

function tone(stream, sampleIndex, hertz) {
  const samples = new Int16Array(FRAME_SAMPLES);
  for (let ii = 0; ii < FRAME_SAMPLES; ++ii) {
    const tt = (sampleIndex + ii) / SAMPLE_RATE;
    samples[ii] = Math.round(Math.sin(2 * Math.PI * hertz * tt) * 0.3 * 32767);
  }
  return encodeFrame(stream, sampleIndex, samples);
}

socket.addEventListener('open', () => {
  socket.send(control.hello(Date.now(), token, 'wire-check.mjs'));
});

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);

  if (message.type === 'error') {
    fail(`server rejected the session: ${message.code} — ${message.message}`);
    return;
  }
  if (message.type !== 'ready') return;

  check('server accepted the handshake', true);

  socket.send(control.streamOpen(STREAM.MIC));
  socket.send(control.streamOpen(STREAM.TAB));

  timer = setInterval(() => {
    if (sent >= frameCount) {
      clearInterval(timer);
      finished = true;
      clearTimeout(watchdog);

      socket.send(control.streamClose(STREAM.MIC, 'user-stopped'));
      socket.send(control.streamClose(STREAM.TAB, 'user-stopped'));
      socket.send(control.bye());

      check(`server accepted all ${sent} frames per stream`, true);
      console.log('\nAll checks passed. Compare the recorded WAVs with the server log.');
      setTimeout(() => { socket.close(); process.exit(0); }, 200);
      return;
    }

    const index = startIndex + sent * FRAME_SAMPLES;
    socket.send(tone(STREAM.MIC, index, 440));
    socket.send(tone(STREAM.TAB, index, 660));
    ++sent;
  }, FRAME_MILLIS);
});

socket.addEventListener('error', () => fail('connection failed'));
socket.addEventListener('close', () => {
  // A malformed frame makes the server close mid-stream, which is the failure this
  // whole check exists to catch.
  if (!finished) fail(`server closed the connection after ${sent} frames`);
});
