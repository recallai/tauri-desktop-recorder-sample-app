// One JSON object per line. stdout is reserved for messages to Tauri.
const readline = require('node:readline');
let sdk;
let initialized = false;

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

const events = [
  'permissions-granted', 'permission-status', 'meeting-detected',
  'meeting-updated', 'meeting-closed', 'recording-started',
  'recording-ended', 'media-capture-status', 'network-status', 'error'
];

async function dispatch(message) {
  const { command, windowId, uploadToken } = message;
  try {
    if (command === 'init') {
      if (initialized) return;
      sdk = require('@recallai/desktop-sdk');
      sdk.init({ apiUrl: process.env.RECALL_API_URL });
      for (const name of events) {
        sdk.addEventListener(name, (data) => send({ type: 'event', name, data }));
      }
      initialized = true;
      for (const permission of ['accessibility', 'microphone', 'screen-capture']) {
        sdk.requestPermission(permission);
      }
      send({ type: 'ready' });
    } else if (!initialized) {
      throw new Error('SDK is not initialized');
    } else if (command === 'start') {
      await sdk.startRecording({ windowId, uploadToken });
      send({ type: 'command-result', command, ok: true, windowId });
    } else if (command === 'stop') {
      await sdk.stopRecording({ windowId });
      send({ type: 'command-result', command, ok: true, windowId });
    } else {
      throw new Error(`Unknown command: ${command}`);
    }
  } catch (error) {
    send({ type: 'command-result', command, ok: false, windowId, error: String(error?.message ?? error) });
  }
}

const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  try { void dispatch(JSON.parse(line)); }
  catch (error) { send({ type: 'protocol-error', error: String(error) }); }
});
