import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { verifyWebhook } from './verify.mjs';

test('accepts a valid Recall signature and rejects altered payloads', () => {
  const secret = `whsec_${Buffer.from('local-test-key').toString('base64')}`;
  const body = '{"event":"sdk_upload.complete"}';
  const timestamp = '1731705121';
  const id = 'msg_test';
  const signature = crypto.createHmac('sha256', Buffer.from('local-test-key'))
    .update(`${id}.${timestamp}.${body}`).digest('base64');
  const headers = { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` };
  const now = Number(timestamp) * 1000;
  assert.equal(verifyWebhook(headers, body, secret, now), true);
  assert.equal(verifyWebhook(headers, body + ' ', secret, now), false);
  assert.equal(verifyWebhook(headers, body, secret, now + 301_000), false);
});
