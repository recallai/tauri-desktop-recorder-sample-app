import crypto from 'node:crypto';

// Recall signs the exact raw UTF-8 body with either webhook-* or legacy svix-* headers.
export function verifyWebhook(headers, body, secret, now = Date.now()) {
  const id = headers['webhook-id'] ?? headers['svix-id'];
  const timestamp = headers['webhook-timestamp'] ?? headers['svix-timestamp'];
  const signatures = headers['webhook-signature'] ?? headers['svix-signature'];
  if (!secret?.startsWith('whsec_') || !id || !timestamp || !signatures) return false;
  const seconds = Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(now / 1000 - seconds) > 300) return false;
  const key = Buffer.from(secret.slice(6), 'base64');
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest();
  return signatures.split(' ').some((item) => {
    const [version, encoded] = item.split(',');
    if (version !== 'v1' || !encoded) return false;
    const actual = Buffer.from(encoded, 'base64');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  });
}
