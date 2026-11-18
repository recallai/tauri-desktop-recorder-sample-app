import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import './style.css';

type Meeting = { id: string; title?: string; url?: string };
type Upload = { id: string; status: string; recordingId: string | null; downloadUrl: string | null };
type SdkMessage = { type: string; name?: string; data?: { window?: Meeting; permission?: string; status?: string; message?: string }; command?: string; ok?: boolean; error?: string };

const api = 'http://127.0.0.1:8787';
const meetings = new Map<string, Meeting>();
const permissions = new Map<string, string>();
let sdkReady = false;
let selectedId = '';
let activeWindowId = '';
let uploadId = '';
let recordingState = 'idle';
let recordingLink = '';
let errorText = '';
let uploadStream: EventSource | null = null;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <main>
    <div class="eyebrow">RECALL.AI · TAURI V2 SAMPLE</div>
    <h1>Meet recorder</h1>
    <p class="intro">Record a Google Meet call on this Mac. The Desktop Recording SDK detects the meeting and captures it locally, with no bot joining the call.</p>
    <section class="card">
      <div class="section-head"><h2>1 · Get ready</h2><span id="sdk-badge" class="badge">Starting SDK</span></div>
      <p>Open a Google Meet call in Chrome. Grant macOS Accessibility, Microphone, and Screen Recording when prompted.</p>
      <div id="permissions" class="permissions"></div>
    </section>
    <section class="card">
      <div class="section-head"><h2>2 · Choose meeting</h2><span id="meeting-count" class="subtle"></span></div>
      <div id="meetings" class="meeting-list"></div>
    </section>
    <section class="card">
      <div class="section-head"><h2>3 · Record</h2><span id="status" class="badge"></span></div>
      <p id="status-detail" class="status-detail"></p>
      <div class="actions"><button id="start" class="primary">Start recording</button><button id="stop" class="secondary">Stop recording</button></div>
      <button id="open" class="link-button" hidden>Open completed recording ↗</button>
      <p id="error" class="error" role="alert"></p>
    </section>
    <p class="footer">The recording is uploaded to Recall. The app waits for the signed <code>sdk_upload.complete</code> webhook before showing its link.</p>
  </main>`;

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const statusNames: Record<string, string> = {
  idle: 'Ready', creating: 'Preparing', starting: 'Starting', recording: 'Recording',
  stopping: 'Stopping', processing: 'Processing', complete: 'Complete', failed: 'Failed'
};
const statusDetails: Record<string, string> = {
  idle: 'Select a detected meeting, then start recording.',
  creating: 'Creating an upload with Recall…',
  starting: 'Waiting for the SDK to begin capture…',
  recording: 'The meeting is being recorded. Keep the Meet window on the current desktop.',
  stopping: 'Stopping capture…',
  processing: 'Capture ended. Waiting for Recall to process the upload and send its webhook…',
  complete: 'Recall has processed the recording. Open it below.',
  failed: 'The upload failed. Check the backend and Recall dashboard logs.'
};

function render() {
  el('sdk-badge').textContent = sdkReady ? 'SDK ready' : 'Starting SDK';
  el('sdk-badge').className = `badge ${sdkReady ? 'good' : ''}`;
  el('permissions').replaceChildren(...['accessibility', 'microphone', 'screen-capture'].map((name) => {
    const chip = document.createElement('span');
    const state = permissions.get(name) ?? 'waiting';
    chip.className = `permission ${state === 'granted' ? 'good' : state === 'denied' ? 'bad' : ''}`;
    chip.textContent = `${name}: ${state}`;
    return chip;
  }));
  el('meeting-count').textContent = `${meetings.size} detected`;
  const list = el('meetings');
  list.replaceChildren();
  if (!meetings.size) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = 'No meeting detected yet. Join Meet in a visible Chrome tab.';
    list.append(empty);
  }
  for (const meeting of meetings.values()) {
    const label = document.createElement('label'); label.className = 'meeting';
    const input = document.createElement('input'); input.type = 'radio'; input.name = 'meeting';
    input.checked = meeting.id === selectedId; input.disabled = !!activeWindowId;
    input.addEventListener('change', () => { selectedId = meeting.id; render(); });
    const content = document.createElement('span');
    const title = document.createElement('strong'); title.textContent = meeting.title || 'Detected meeting';
    const detail = document.createElement('small'); detail.textContent = meeting.url || `Window ${meeting.id}`;
    content.append(title, detail); label.append(input, content); list.append(label);
  }
  el('status').textContent = statusNames[recordingState] ?? recordingState;
  el('status').className = `badge ${recordingState === 'recording' ? 'recording' : recordingState === 'complete' ? 'good' : ''}`;
  el('status-detail').textContent = statusDetails[recordingState] ?? '';
  el<HTMLButtonElement>('start').disabled = !sdkReady || !selectedId || !!activeWindowId || !['idle', 'complete', 'failed'].includes(recordingState);
  el<HTMLButtonElement>('stop').disabled = !activeWindowId || !['starting', 'recording'].includes(recordingState);
  el<HTMLButtonElement>('open').hidden = !recordingLink;
  el('error').textContent = errorText;
}

async function createUpload() {
  const response = await fetch(`${api}/api/uploads`, { method: 'POST' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Could not create upload');
  return result as { id: string; uploadToken: string };
}

function applyUpload(upload: Upload) {
  if (upload.id !== uploadId) return;
  if (upload.status === 'complete') {
    recordingState = 'complete'; activeWindowId = '';
    recordingLink = upload.downloadUrl ?? '';
    errorText = recordingLink ? '' : 'Recall reported completion without a video link.';
  } else if (upload.status === 'failed') {
    recordingState = 'failed'; activeWindowId = '';
  } else if (upload.status === 'processing' && !['complete', 'failed'].includes(recordingState)) {
    recordingState = 'processing'; activeWindowId = '';
  } else if (upload.status === 'recording' && recordingState === 'starting') {
    recordingState = 'recording';
  }
  render();
}

function subscribeToUpload(id: string) {
  uploadStream?.close();
  uploadStream = new EventSource(`${api}/api/events?uploadId=${encodeURIComponent(id)}`);
  uploadStream.onmessage = (event) => {
    try { applyUpload(JSON.parse(event.data) as Upload); }
    catch (error) { errorText = `Invalid backend event: ${String(error)}`; render(); }
  };
}

el<HTMLButtonElement>('start').addEventListener('click', async () => {
  const windowId = selectedId;
  if (!windowId) return;
  uploadStream?.close(); uploadStream = null;
  errorText = ''; recordingLink = ''; uploadId = ''; recordingState = 'creating'; render();
  try {
    const upload = await createUpload();
    uploadId = upload.id; activeWindowId = windowId; recordingState = 'starting';
    subscribeToUpload(uploadId); render();
    await invoke('sdk_command', { payload: { command: 'start', windowId, uploadToken: upload.uploadToken } });
  } catch (error) { errorText = String(error); recordingState = 'idle'; activeWindowId = ''; render(); }
});

el<HTMLButtonElement>('stop').addEventListener('click', async () => {
  recordingState = 'stopping'; render();
  try { await invoke('sdk_command', { payload: { command: 'stop', windowId: activeWindowId } }); }
  catch (error) { errorText = String(error); recordingState = 'recording'; render(); }
});
el<HTMLButtonElement>('open').addEventListener('click', () => { if (recordingLink) void openUrl(recordingLink); });

function onSdkMessage(message: SdkMessage) {
  if (message.type === 'ready') sdkReady = true;
  if (message.type === 'sidecar-exit') { sdkReady = false; errorText = 'SDK sidecar exited. Restart the app.'; }
  if (message.type === 'command-result' && !message.ok) {
    errorText = message.error ?? `${message.command} failed`;
    if (message.command === 'start') { activeWindowId = ''; recordingState = 'idle'; }
    if (message.command === 'stop') recordingState = 'recording';
  }
  if (message.type === 'command-result' && message.ok && message.command === 'stop' && recordingState === 'stopping') {
    recordingState = 'processing'; activeWindowId = '';
  }
  if (message.type === 'event') {
    const event = message.data;
    if (message.name === 'permission-status' && event?.permission && event.status) permissions.set(event.permission, event.status);
    if (message.name === 'permissions-granted') for (const name of ['accessibility', 'microphone', 'screen-capture']) permissions.set(name, 'granted');
    if ((message.name === 'meeting-detected' || message.name === 'meeting-updated') && event?.window?.id) {
      meetings.set(event.window.id, { ...meetings.get(event.window.id), ...event.window });
      if (!selectedId) selectedId = event.window.id;
    }
    if (message.name === 'meeting-closed' && event?.window?.id) {
      meetings.delete(event.window.id);
      if (selectedId === event.window.id) selectedId = meetings.keys().next().value ?? '';
    }
    if (message.name === 'recording-started' && event?.window?.id === activeWindowId) recordingState = 'recording';
    if (message.name === 'recording-ended' && event?.window?.id === activeWindowId && !['complete', 'failed'].includes(recordingState)) { recordingState = 'processing'; activeWindowId = ''; }
    if (message.name === 'error') errorText = event?.message ?? 'SDK reported an error';
  }
  render();
}

render();
void listen<SdkMessage>('sdk-message', (event) => onSdkMessage(event.payload)).then(() =>
  invoke('sdk_command', { payload: { command: 'init' } }).catch((error) => { errorText = String(error); render(); })
);
