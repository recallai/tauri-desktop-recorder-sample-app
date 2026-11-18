import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createUploadEvents } from './stream.mjs';

test('SSE sends the current upload and later webhook updates', () => {
  const hub = createUploadEvents();
  const messages = [];
  const response = Object.assign(new EventEmitter(), {
    writeHead(status, headers) { assert.equal(status, 200); assert.match(headers['content-type'], /text\/event-stream/); },
    write(message) { messages.push(message); }
  });
  hub.subscribe(response, { id: 'upload-1', status: 'created' });
  hub.publish({ id: 'upload-1', status: 'complete', downloadUrl: 'https://example.com/video' });
  hub.publish({ id: 'upload-2', status: 'failed' });
  assert.equal(messages.length, 2);
  assert.deepEqual(JSON.parse(messages[0].slice(6)), { id: 'upload-1', status: 'created' });
  assert.equal(JSON.parse(messages[1].slice(6)).downloadUrl, 'https://example.com/video');
  response.emit('close');
  hub.publish({ id: 'upload-1', status: 'failed' });
  assert.equal(messages.length, 2);
});
