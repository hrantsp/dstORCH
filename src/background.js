// Service worker: owns the toolbar action and the offscreen document's lifetime.
//
// It handles no audio itself. MV3 service workers have no DOM and are terminated when
// idle, so capture and the socket both live in the offscreen document; this worker
// only starts and stops them.

import { DEFAULT_PORT } from './generated/protocol.js';

const OFFSCREEN_PATH = 'src/offscreen.html';

let capturingTabId = null;

// The tab the user asked to capture before we discovered the microphone had not been
// granted. Capture resumes on it automatically once permission is given, so the user
// does not have to remember where they were.
let pendingTabId = null;

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    // USER_MEDIA covers both the microphone and the tab stream; AUDIO_PLAYBACK is
    // what allows the captured tab audio to be played back, without which the user
    // stops hearing their own meeting.
    reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
    justification:
      'Captures microphone and meeting audio and streams both to the dstDESK desktop app.',
  });
}

async function readConfig() {
  const stored = await chrome.storage.local.get({ port: DEFAULT_PORT, token: '' });
  return { port: Number(stored.port) || DEFAULT_PORT, token: stored.token ?? '' };
}

async function setBadge(text, colour, title) {
  await chrome.action.setBadgeText({ text });
  if (colour) await chrome.action.setBadgeBackgroundColor({ color: colour });
  if (title) await chrome.action.setTitle({ title });
}

// Opens the options page with the prompt already firing. An offscreen document cannot
// ask for the microphone, so the request has to happen on a real extension page — and
// opening it automatically is the difference between "it asked me" and "it told me to
// go and find a settings screen".
async function requestMicrophone(tabId) {
  pendingTabId = tabId;
  await setBadge('?', '#d35400', 'dstORCH: microphone access needed');
  await chrome.tabs.create({
    url: chrome.runtime.getURL('src/options.html?request=1'),
  });
}

async function startCapture(tab) {
  // getMediaStreamId is the service worker's half of tab capture: it yields a token
  // the offscreen document exchanges for the actual stream. chrome.tabCapture.capture
  // needs a DOM and cannot run here.
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  await ensureOffscreenDocument();

  capturingTabId = tab.id;
  await setBadge('●', '#c0392b', 'Capturing — click to stop');

  await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    streamId,
    config: await readConfig(),
  });
}

async function stopCapture() {
  if (await hasOffscreenDocument()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop' });
    await chrome.offscreen.closeDocument();
  }
  capturingTabId = null;
  await setBadge('', null, 'Start capturing this tab');
}

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (capturingTabId !== null) {
      await stopCapture();
      return;
    }
    await startCapture(tab);
  } catch (err) {
    await setBadge('!', '#c0392b', `dstORCH: ${err?.message ?? err}`);
    capturingTabId = null;
  }
});

// Capturing a tab that has gone away is meaningless, and leaving the offscreen
// document open would keep a dead socket retrying forever.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabId === capturingTabId) await stopCapture();
});

chrome.runtime.onMessage.addListener((message) => {
  // Sent by the options page once the user grants the microphone. Capture resumes on
  // whichever tab they originally clicked.
  if (message?.type === 'mic-granted') {
    const tabId = pendingTabId;
    pendingTabId = null;

    if (tabId === null) return false;

    chrome.tabs
      .get(tabId)
      .then((tab) => startCapture(tab))
      .catch(async () => {
        // Resuming can fail if the tab closed, or if tabCapture no longer considers
        // the extension invoked on it. Neither is worth an error badge — clicking
        // the button again just works now that the microphone is granted.
        await setBadge('', null, 'Click to start capturing this tab');
      });
    return false;
  }

  if (message?.type !== 'status') return false;

  if (message.state === 'needs-mic') {
    const tabId = capturingTabId;
    capturingTabId = null;
    chrome.offscreen.closeDocument().catch(() => {});
    requestMicrophone(tabId);
    return false;
  }

  if (message.state === 'error') {
    setBadge('!', '#c0392b', `dstORCH: ${message.detail}`);
  } else if (message.state === 'reconnecting') {
    setBadge('…', '#d35400', `dstORCH: ${message.detail}`);
  } else if (message.state === 'capturing') {
    setBadge('●', '#c0392b', `dstORCH: ${message.detail}`);
  } else if (message.state === 'stopped') {
    setBadge('', null, 'Start capturing this tab');
    capturingTabId = null;
  }

  return false;
});
