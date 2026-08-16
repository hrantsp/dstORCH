import { DEFAULT_PORT } from './generated/protocol.js';

const portInput = document.getElementById('port');
const tokenInput = document.getElementById('token');
const savedNote = document.getElementById('saved');
const micState = document.getElementById('micState');

// ── settings ─────────────────────────────────────────────────────────────────

const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: '' });
portInput.value = stored.port;
tokenInput.value = stored.token;

let saveTimer = null;

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const port = Number(portInput.value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      savedNote.textContent = 'Port must be between 1 and 65535.';
      savedNote.className = 'bad';
      return;
    }

    await chrome.storage.local.set({ port, token: tokenInput.value.trim() });
    savedNote.textContent = 'Saved.';
    savedNote.className = 'ok';
  }, 300);
}

portInput.addEventListener('input', save);
tokenInput.addEventListener('input', save);

// ── microphone permission ────────────────────────────────────────────────────

async function showMicState() {
  // An offscreen document cannot raise a permission prompt, so the grant has to
  // happen on a real extension page — this one. Reporting the current state here
  // makes the requirement visible instead of surfacing later as a capture failure.
  try {
    const status = await navigator.permissions.query({ name: 'microphone' });
    if (status.state === 'granted') {
      micState.textContent = 'Granted.';
      micState.className = 'ok';
    } else if (status.state === 'denied') {
      micState.textContent = 'Blocked. Allow the microphone for this extension in Chrome site settings.';
      micState.className = 'bad';
    } else {
      micState.textContent = 'Not granted yet.';
      micState.className = '';
    }
  } catch {
    micState.textContent = '';
  }
}

async function requestMicrophone() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    // The permission is what matters, not the stream; releasing it immediately keeps
    // the recording indicator off until a call actually starts.
    stream.getTracks().forEach((track) => track.stop());

    micState.textContent = 'Granted.';
    micState.className = 'ok';

    // Lets the service worker resume capture on the tab the user originally clicked.
    chrome.runtime.sendMessage({ type: 'mic-granted' }).catch(() => {});
    return true;
  } catch (err) {
    micState.textContent = `Refused: ${err?.message ?? err}`;
    micState.className = 'bad';
    return false;
  }
}

document.getElementById('grant').addEventListener('click', requestMicrophone);

await showMicState();

// Opened by the extension because capture needed the microphone: ask straight away
// rather than making the user find the button on a page they did not choose to visit.
if (new URLSearchParams(location.search).has('request')) {
  const status = document.getElementById('grant');
  status.focus();
  await requestMicrophone();
}
