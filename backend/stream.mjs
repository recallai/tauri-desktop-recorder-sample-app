// A small Server-Sent Events hub for the local desktop UI. Each connection
// subscribes to one upload and receives its current state immediately.
export function createUploadEvents() {
  const subscribers = new Map();

  function publish(upload) {
    const message = `data: ${JSON.stringify(upload)}\n\n`;
    for (const response of subscribers.get(upload.id) ?? []) response.write(message);
  }

  function subscribe(response, upload) {
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'access-control-allow-origin': 'http://127.0.0.1:1420',
      connection: 'keep-alive'
    });
    let group = subscribers.get(upload.id);
    if (!group) { group = new Set(); subscribers.set(upload.id, group); }
    group.add(response);
    publish(upload);
    response.on('close', () => {
      group.delete(response);
      if (!group.size) subscribers.delete(upload.id);
    });
  }

  return { publish, subscribe };
}
