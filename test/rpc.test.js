import test from 'node:test';
import assert from 'node:assert/strict';
import { Rpc, MONERO_METHODS, SOLANA_METHODS, atomic, parseJson, safeError } from '../src/rpc.js';
import { config } from '../src/config.js';

test('read clients reject spend, sign, broadcast, and key-export methods before HTTP', async () => {
  let calls = 0;
  for (const methods of [MONERO_METHODS, SOLANA_METHODS]) {
    const rpc = new Rpc('http://127.0.0.1', methods, { fetchImpl: async () => { calls++; } });
    for (const method of ['transfer', 'sweep_all', 'sendTransaction', 'query_key', 'get_tx_key', 'sign', 'submit_transfer']) {
      await assert.rejects(rpc.call(method), /not allowed/);
    }
  }
  assert.equal(calls, 0);
});
test('lossless JSON preserves atomic amounts and rejects prototype properties', () => {
  assert.equal(atomic(parseJson('{"received":9007199254740993}').received), '9007199254740993');
  assert.equal(parseJson('{"uiAmount":266.671935108756}').uiAmount, '266.671935108756');
  assert.throws(() => atomic(9007199254740993), /Imprecise/);
  assert.throws(() => parseJson('{"__proto__":{}}'));
});
test('RPC errors never include URL credentials or server response bodies', async () => {
  const rpc = new Rpc('https://example.invalid/?token=not-a-real-credential', MONERO_METHODS, {
    label: 'Monero', fetchImpl: async () => new Response('sensitive server body', { status: 429 }),
  });
  await assert.rejects(rpc.call('get_height'), error => {
    assert.equal(safeError(error), 'Monero get_height: HTTP 429');
    assert.equal(error.name, 'RpcError');
    assert.equal(error.retryAfter, 60000);
    return true;
  });
});
test('wallet RPC must be loopback and configuration has no key setting', () => {
  assert.throws(() => config({ MONERO_WALLET_RPC_URL: 'http://example.com/json_rpc' }), /loopback/);
  assert.equal(Object.keys(config({})).some(key => /private|seed|spend/i.test(key)), false);
});

test('shutdown cancels a rate-limit wait without sending another request', async () => {
  let calls = 0;
  const rpc = new Rpc('http://127.0.0.1', MONERO_METHODS, { fetchImpl: async () => { calls++; } });
  rpc.nextAt = Date.now() + 300000;
  const pending = rpc.call('get_height');
  await new Promise(resolve => setImmediate(resolve));
  rpc.close();
  await assert.rejects(pending, /stopped/);
  assert.equal(calls, 0);
});
