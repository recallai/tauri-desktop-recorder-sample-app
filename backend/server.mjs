import http from 'node:http';
import { verifyWebhook } from './verify.mjs';
import { createUploadEvents } from './stream.mjs';

const apiUrl = process.env.RECALL_API_URL?.replace(/\/$/, '');
const apiKey = process.env.RECALL_API_KEY;
const webhookSecret = process.env.RECALL_WEBHOOK_SECRET;
const webhookPort = Number(process.env.WEBHOOK_PORT ?? 3000);
if (!Number.isInteger(webhookPort) || webhookPort < 1 || webhookPort > 65535) {
  console.error('WEBHOOK_PORT must be an integer from 1 to 65535.');
  process.exit(1);
}
if (!apiUrl?.startsWith('https://') || !apiKey || apiKey.startsWith('replace-') || !webhookSecret?.startsWith('whsec_') || webhookSecret.includes('replace-')) {
  console.error('Set RECALL_API_URL, RECALL_API_KEY, and RECALL_WEBHOOK_SECRET in .env.');
  process.exit(1);
}

const uploads = new Map();
const uploadEvents = createUploadEvents();
const uploadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const emptyUpload = (id) => ({ id, status: 'created', recordingId: null, downloadUrl: null });
const json = (res, status, value) => {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': 'http://127.0.0.1:1420', 'access-control-allow-headers': 'content-type' });
  res.end(JSON.stringify(value));
};

async function recall(path, options = {}) {
  const response = await fetch(`${apiUrl}/api/v1/${path}`, {
    ...options,
    signal: AbortSignal.timeout(10_000),
    headers: { authorization: `Token ${apiKey}`, accept: 'application/json', ...options.headers }
  });
  if (!response.ok) throw new Error(`Recall API returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return response.json();
}

async function refreshRecording(upload) {
  if (!upload.recordingId) throw new Error('Completion webhook did not include a recording id');
  const recording = await recall(`recording/${encodeURIComponent(upload.recordingId)}/`);
  const media = recording.media_shortcuts?.video_mixed;
  const url = media?.status?.code === 'done' ? media.data?.download_url : null;
  if (!url) throw new Error('Recall has not returned a completed video link');
  upload.downloadUrl = url;
}

const localApi = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (req.method === 'GET' && req.url === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && req.url?.startsWith('/api/events?')) {
      const id = new URL(req.url, 'http://localhost').searchParams.get('uploadId');
      if (!id || !uploadIdPattern.test(id)) return json(res, 400, { error: 'Invalid upload id' });
      // The desktop UI can reconnect after a backend restart. A later verified
      // webhook will fill in this placeholder and push the completed state.
      let upload = uploads.get(id);
      if (!upload) {
        upload = emptyUpload(id);
        uploads.set(id, upload);
        console.log(`Restored local event stream for upload ${id}; waiting for a webhook`);
      }
      uploadEvents.subscribe(res, upload);
      return;
    }
    if (req.method === 'POST' && req.url === '/api/uploads') {
      const result = await recall('sdk_upload/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      if (!result.id || !result.upload_token) throw new Error('Recall response lacked an upload id or token');
      uploads.set(result.id, emptyUpload(result.id));
      console.log(`Created SDK upload ${result.id}; waiting for Recall webhooks`);
      return json(res, 201, { id: result.id, uploadToken: result.upload_token });
    }
    return json(res, 404, { error: 'Not found' });
  } catch (error) { return json(res, 502, { error: String(error.message ?? error) }); }
});

const webhook = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !['/api/webhook', '/webhooks/recall'].includes(req.url)) {
    console.warn(`Webhook receiver got unexpected ${req.method} ${req.url}`);
    res.writeHead(404).end(); return;
  }
  console.log('Webhook request reached the local receiver');
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
      if (chunks.reduce((sum, part) => sum + part.length, 0) > 1_000_000) throw new Error('Webhook too large');
    }
    const body = Buffer.concat(chunks).toString('utf8');
    if (!verifyWebhook(req.headers, body, webhookSecret)) {
      console.warn('Webhook signature rejected; check the signing secret and Recall account type');
      res.writeHead(401).end('Invalid signature'); return;
    }
    const event = JSON.parse(body);
    const id = event.data?.sdk_upload?.id;
    if (id && uploadIdPattern.test(id) && event.event?.startsWith('sdk_upload.')) {
      let upload = uploads.get(id);
      if (!upload) {
        upload = emptyUpload(id);
        uploads.set(id, upload);
        console.log(`Restored upload ${id} from verified Recall webhook`);
      }
      if (event.event === 'sdk_upload.complete') {
        upload.recordingId = event.data?.recording?.id ?? null;
        try { await refreshRecording(upload); }
        catch (error) {
          console.error('Recording lookup failed; Recall can retry the webhook:', error);
          res.writeHead(503).end('Recording link unavailable');
          return;
        }
        upload.status = 'complete';
      } else if (event.event === 'sdk_upload.failed' && upload.status !== 'complete') upload.status = 'failed';
      else if (event.event === 'sdk_upload.recording_started' && upload.status === 'created') upload.status = 'recording';
      else if (event.event === 'sdk_upload.recording_ended' && !['complete', 'failed'].includes(upload.status)) upload.status = 'processing';
      uploadEvents.publish(upload);
      console.log(`${event.event}: ${id}`);
    } else console.warn(`Ignored verified event without a Desktop SDK upload id: ${event.event}`);
    res.writeHead(204).end();
  } catch (error) { console.error('Webhook error:', error); res.writeHead(400).end('Bad webhook'); }
});

localApi.listen(8787, '127.0.0.1', () => console.log('Local API: http://127.0.0.1:8787'));
webhook.listen(webhookPort, '127.0.0.1', () => console.log(`Webhook receiver: http://127.0.0.1:${webhookPort}/api/webhook`));
