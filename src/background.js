// Service worker: owns the toolbar action and the offscreen document's lifetime.
//
// It handles no audio. MV3 service workers have no DOM and are terminated when idle,
// so capture and the socket both live in the offscreen document; this worker only
// starts and stops them.
//
// Nothing here may be remembered in a module variable. Chrome kills this worker after
// roughly thirty seconds of inactivity and restarts it on the next event with every
// variable back at its initial value — so "am I capturing?" is answered by asking
// whether the offscreen document exists, and anything else lives in session storage.

import { DEFAULT_PORT } from './generated/protocol.js';

const OFFSCREEN_PATH = 'src/offscreen.html';

// ── durable state ────────────────────────────────────────────────────────────

async function readSession(defaults) {
  return chrome.storage.session.get(defaults);
}

async function writeSession(values) {
  await chrome.storage.session.set(values);
}

async function isCapturing() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

// ── plumbing ─────────────────────────────────────────────────────────────────

async function ensureOffscreenDocument() {
  if (await isCapturing()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // USER_MEDIA covers both the microphone and the tab stream; AUDIO_PLAYBACK is
    // what allows the captured tab audio to be played back, without which the user
    // stops hearing their own meeting.
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification:
      'Captures microphone and meeting audio and streams both to the Kobayashi desktop app.',
  });
}

async function readConfig() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: '' });
  return {
    port: Number(stored.port) || DEFAULT_PORT,
    token: stored.token ?? '',
    // Read here, in the service worker, and carried to the offscreen document. Reading
    // it there produced "unknown" on a real run, and a client that cannot state its own
    // version defeats the point of tagging both halves in lockstep.
    version: chrome.runtime.getManifest().version,
  };
}

async function setBadge(text, colour, title) {
  await chrome.action.setBadgeText({ text });
  if (colour) await chrome.action.setBadgeBackgroundColor({ color: colour });
  if (title) await chrome.action.setTitle({ title });
}

// ── microphone permission ────────────────────────────────────────────────────

// Opens the options page with the prompt already firing. An offscreen document cannot
// ask for the microphone, so the request has to happen on a real extension page — and
// opening it automatically is the difference between "it asked me" and "it told me to
// go and find a settings screen".
async function requestMicrophone(tabId) {
  await writeSession({ pendingTabId: tabId });
  await setBadge('?', '#d35400', 'Verbal: microphone access needed');
  await chrome.tabs.create({
    url: chrome.runtime.getURL('src/options.html?request=1'),
  });
}

// ── start and stop ───────────────────────────────────────────────────────────

async function startCapture(tab) {
  // getMediaStreamId is the service worker's half of tab capture: it yields a token
  // the offscreen document exchanges for the actual stream. chrome.tabCapture.capture
  // needs a DOM and cannot run here.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  await ensureOffscreenDocument();
  await writeSession({ capturingTabId: tab.id });
  await setBadge('●', '#c0392b', 'Capturing — click to stop');

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    config: await readConfig(),
  });
}

async function stopCapture() {
  if (await isCapturing()) {
    // Best-effort: the offscreen document may already be gone, and failing to say
    // goodbye must not prevent the teardown that follows.
    await chrome.runtime
      .sendMessage({ target: 'offscreen', type: 'stop' })
      .catch(() => {});
    await chrome.offscreen.closeDocument().catch(() => {});
  }

  await writeSession({ capturingTabId: null, pendingTabId: null });
  await setBadge('', null, 'Start capturing this tab');
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    // Asked, not remembered. After the worker has been restarted, a module variable
    // would say "not capturing" while the offscreen document is still running — and
    // the click would silently start a second capture instead of stopping the first.
    if (await isCapturing()) {
      await stopCapture();
      return;
    }
    await startCapture(tab);
  } catch (err) {
    // Any failure must leave the extension clickable again, or the only way out is to
    // reload it from chrome://extensions.
    await stopCapture();
    await setBadge('!', '#c0392b', `Verbal: ${err?.message ?? err}`);
  }
});

// Capturing a tab that has gone away is meaningless, and leaving the offscreen
// document open would keep a dead socket retrying forever.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { capturingTabId } = await readSession({ capturingTabId: null });
  if (tabId === capturingTabId) await stopCapture();
});

// ── messages ─────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === 'mic-granted') {
    readSession({ pendingTabId: null }).then(async ({ pendingTabId }) => {
      await writeSession({ pendingTabId: null });
      if (pendingTabId === null) return;

      try {
        await startCapture(await chrome.tabs.get(pendingTabId));
      } catch {
        // Resuming can fail if the tab closed, or if tabCapture no longer considers
        // the extension invoked on it. Clicking the button again just works now that
        // the microphone is granted.
        await setBadge('', null, 'Click to start capturing this tab');
      }
    });
    return false;
  }

  if (message?.type !== 'status') return false;

  if (message.state === 'needs-mic') {
    readSession({ capturingTabId: null }).then(async ({ capturingTabId }) => {
      await chrome.offscreen.closeDocument().catch(() => {});
      await writeSession({ capturingTabId: null });
      await requestMicrophone(capturingTabId);
    });
    return false;
  }

  if (message.state === 'error') {
    // An error leaves capture running but broken. Clearing state here means the next
    // click stops it cleanly instead of stacking another attempt on top.
    setBadge('!', '#c0392b', `Verbal: ${message.detail}`);
  } else if (message.state === 'reconnecting') {
    setBadge('…', '#d35400', `Verbal: ${message.detail} — click to stop`);
  } else if (message.state === 'capturing') {
    setBadge('●', '#c0392b', `Verbal: ${message.detail}`);
  } else if (message.state === 'stopped') {
    // The offscreen document tore itself down — after a rejected handshake, say.
    // Clear up directly rather than calling stopCapture, which would message it back
    // and bounce another 'stopped' straight to this handler.
    chrome.offscreen.closeDocument().catch(() => {});
    writeSession({ capturingTabId: null, pendingTabId: null });
    setBadge('', null, 'Start capturing this tab');
  }

  return false;
});
