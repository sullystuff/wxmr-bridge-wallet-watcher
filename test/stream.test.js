import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { Store } from '../src/store.js';
import { SolanaWatcher } from '../src/solana.js';
import { config, manifest } from '../src/config.js';

test('reconnects finalized log subscription and wakes durable catch-up without accepting socket data as proof', { timeout: 7000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const store = new Store(':memory:');
  const watcher = new SolanaWatcher(config({ SOLANA_WS_URL: `ws://127.0.0.1:${server.address().port}` }), store);
  let connections = 0;
  const subscribed = new Promise(resolve => server.on('connection', socket => {
    connections++;
    socket.on('message', raw => {
      const request = JSON.parse(raw.toString());
      assert.equal(request.method, 'logsSubscribe');
      assert.deepEqual(request.params, [{ mentions: [manifest.solana.programId] }, { commitment: 'finalized' }]);
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, result: connections }));
      if (connections === 1) setTimeout(() => socket.close(), 20);
      else {
        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'logsNotification', params: { result: { value: { signature: 'socket-hint-only' } } } }));
        resolve();
      }
    });
  }));
  try {
    watcher.nextDiscovery = Number.MAX_SAFE_INTEGER;
    watcher.startStream();
    await subscribed;
    await delay(20);
    assert.equal(connections, 2);
    assert.equal(watcher.nextDiscovery, 0);
    assert.equal(store.get('solanaHead'), null);
    assert.equal(store.pendingCount(), 0);
    assert.equal(store.lastSeq(), 0);
  } finally {
    watcher.stop();
    await new Promise(resolve => server.close(resolve));
    store.close();
  }
});
