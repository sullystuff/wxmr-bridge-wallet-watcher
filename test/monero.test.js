import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { MoneroWatcher, classifyProof } from '../src/monero.js';
import { generationParams } from '../src/wallet.js';
import { config, manifest } from '../src/config.js';

const txid = 'a'.repeat(64);
const address = manifest.monero.primaryAddress;
const key = manifest.monero.publishedViewKey; // Public fixture value; no private test key is bundled.
const cfg = config({});
const daemon = { call: async () => ({ height: 200, nettype: 'mainnet', synchronized: true, offline: false }) };
function output(n, amount = 10n) {
  return { tx_hash: txid, pubkey: String(n).repeat(64), amount,
    subaddr_index: { major: 0, minor: 0 }, block_height: 100 };
}
test('wallet creation passes only the website-published view key and never a spend key or seed', () => {
  const params = generationParams(cfg);
  assert.equal(params.address, address);
  assert.equal(params.viewkey, key);
  assert.equal(Object.hasOwn(params, 'spendkey'), false);
  assert.equal(Object.hasOwn(params, 'seed'), false);
  assert.equal(params.autosave_current, false);
});
test('tracks individual outputs, preserves atomic precision, deduplicates scans, and reports reorg removals', async () => {
  const store = new Store(':memory:');
  let outputs = [output(1, 9007199254740993n), output(2)];
  const rpc = { call: async method => {
    if (method === 'get_address') return { address };
    if (method === 'get_height') return { height: 200 };
    if (method === 'incoming_transfers') return { transfers: outputs };
    throw new Error(`Unexpected ${method}`);
  } };
  try {
    const watcher = new MoneroWatcher(cfg, store, rpc, daemon);
    await watcher.scanReceipts();
    assert.equal(store.events().length, 2);
    assert.equal(store.events()[0].data.amountAtomic, '9007199254740993');
    assert.equal(store.events()[0].data.spendStatus, 'unknown_from_view_key');
    await watcher.scanReceipts();
    assert.equal(store.events().length, 2);
    outputs = [output(2)];
    await watcher.scanReceipts();
    assert.equal(store.events().at(-1).kind, 'IncomingOutputMissing');
    outputs = [output(1, 9007199254740993n), output(2)];
    await watcher.scanReceipts();
    assert.equal(store.events().at(-1).kind, 'IncomingOutputObserved');
  } finally { store.close(); }
});
test('unavailable or changing wallet scans never mark previous outputs missing', async () => {
  const store = new Store(':memory:');
  try {
    store.saveReceipts([{ txid, outputPublicKey: '1'.repeat(64), address, amountAtomic: '10', state: 'confirmed' }], 200);
    const initial = store.lastSeq();
    let height = 200;
    const watcher = new MoneroWatcher(cfg, store, { call: async method => {
      if (method === 'get_address') return { address };
      if (method === 'get_height') return { height: height++ };
      if (method === 'incoming_transfers') return { transfers: [] };
    } }, daemon);
    await watcher.scanReceipts();
    assert.equal(store.lastSeq(), initial);
    watcher.rpc.call = async () => { throw new Error('simulated outage'); };
    await watcher.tick(true);
    assert.equal(store.lastSeq(), initial);
    assert.ok(store.get('moneroError'));
  } finally { store.close(); }
});
test('rejects a different wallet before fetching transfers or proofs', async () => {
  const store = new Store(':memory:');
  try {
    let calls = 0;
    const watcher = new MoneroWatcher(cfg, store, { call: async () => { calls++; return { address: 'different-address' }; } }, daemon);
    await watcher.tick(true);
    assert.equal(calls, 1);
    assert.ok(store.get('moneroError'));
  } finally { store.close(); }
});
test('checks shared batch payouts once per tx/address and preserves fee-deducted amount differences', async () => {
  const store = new Store(':memory:');
  try {
    store.addProof('record-1', 'withdrawal', txid, address, key + key, 'transaction:public-1', '10');
    store.addProof('record-2', 'withdrawal', txid, address, key + key, 'transaction:public-2', '20');
    let calls = 0;
    const watcher = new MoneroWatcher(cfg, store, { call: async (method, params) => {
      assert.equal(method, 'check_tx_key');
      assert.equal(params.tx_key, key + key);
      calls++;
      return { received: 25, confirmations: 12, in_pool: false };
    } }, daemon);
    await watcher.verifyProofs();
    assert.equal(calls, 1);
    const proof = store.events().at(-1).data;
    assert.equal(proof.reportedWithdrawalAmountAtomic, '30');
    assert.equal(proof.receivedAtomic, '25');
    assert.equal(proof.state, 'payment_confirmed');
    assert.equal(proof.amountComparison, 'below_reported_total');
  } finally { store.close(); }
});
test('a public completion does not become payment-confirmed without positive mined evidence', () => {
  const group = [{ txid, address, purpose: 'withdrawal', amount: '10', source: 'transaction:public' }];
  assert.equal(classifyProof(group, { received: 0, confirmations: 100, in_pool: false }, 10).state, 'no_payment_found');
  assert.equal(classifyProof(group, { received: 10, confirmations: 9, in_pool: false }, 10).state, 'payment_confirming');
  assert.equal(classifyProof(group, { received: 10, confirmations: 20, in_pool: true }, 10).state, 'payment_confirming');
  assert.equal(classifyProof(group, { received: 10, confirmations: 10, in_pool: false }, 10).state, 'payment_confirmed');
});
test('unpublished proof keys remain explicitly unavailable without RPC guesses', async () => {
  const store = new Store(':memory:');
  try {
    store.addProof('empty', 'withdrawal', txid, address, '', 'transaction:public', '10');
    const watcher = new MoneroWatcher(cfg, store, { call: async () => { assert.fail('no key means no proof RPC'); } }, daemon);
    await watcher.verifyProofs();
    assert.equal(store.events().at(-1).data.state, 'public_proof_unavailable');
  } finally { store.close(); }
});
