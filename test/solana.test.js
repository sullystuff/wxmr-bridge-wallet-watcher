import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { SolanaWatcher } from '../src/solana.js';
import { config, manifest } from '../src/config.js';
import { eventLogs, mint, program } from './helpers.js';

const signature = (name, slot = 10) => ({ signature: name, slot, blockTime: 100, err: null });
test('new live records take priority over older backfill work', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue([signature('historical', 1)], 1);
    store.enqueue([signature('live', 100)]);
    assert.deepEqual(store.pending(2).map(row => row.signature), ['live', 'historical']);
  } finally { store.close(); }
});
test('persists every queued signature before advancing the head; resumes an interrupted catch-up', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'wxmr-history-test-'));
  let store = new Store(join(directory, 'state.sqlite'));
  try {
    store.set('solanaHead', 'old');
    let watcher = new SolanaWatcher(config({}), store, { call: async () => [signature('newest', 12), signature('middle', 11)] });
    await watcher.discoverRecent();
    assert.equal(store.get('solanaHead'), 'old');
    assert.equal(store.get('recentScan').before, 'middle');
    assert.equal(store.pendingCount(), 2);
    store.close(); store = new Store(join(directory, 'state.sqlite'));
    watcher = new SolanaWatcher(config({}), store, { call: async () => [signature('old')] });
    await watcher.discoverRecent();
    assert.equal(store.get('solanaHead'), 'newest');
    assert.equal(store.get('recentScan'), null);
    assert.deepEqual(store.pending(10).map(row => row.signature), ['middle', 'newest']);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});
test('history retention gaps are visible and never discard the old head', async () => {
  const store = new Store(':memory:');
  try {
    store.set('solanaHead', 'old');
    const watcher = new SolanaWatcher(config({}), store, { call: async () => [] });
    await assert.rejects(watcher.discoverRecent(), /history gap/);
    assert.equal(store.get('solanaHead'), 'old');
    assert.equal(store.get('historyGap').stop, 'old');
  } finally { store.close(); }
});
test('null transactions stay retryable, failed transactions are skipped, and events deduplicate', async () => {
  const store = new Store(':memory:');
  try {
    store.enqueue([signature('missing', 11), signature('valid'), { ...signature('failed'), err: 'failed' }]);
    const watcher = new SolanaWatcher(config({}), store, { call: async (method, params) => {
      assert.equal(method, 'getTransaction');
      if (params[0] === 'missing') return null;
      assert.equal(params[0], 'valid');
      return { slot: 10, transaction: { signatures: ['valid'], message: { instructions: [] } },
        meta: { err: null, logMessages: eventLogs('DepositMintedEvent', mint) } };
    } });
    await watcher.processPending();
    assert.equal(store.pendingCount(), 1);
    assert.equal(store.status().unresolvedSolanaTransactions[0].signature, 'missing');
    assert.equal(store.events().length, 1);
    store.db.prepare('UPDATE queue SET done=0 WHERE signature=?').run('valid');
    await watcher.processPending();
    assert.equal(store.events().length, 1);
  } finally { store.close(); }
});
test('a failed database transaction rolls back events and processing status together', () => {
  const store = new Store(':memory:');
  try {
    store.enqueue([signature('valid')]);
    assert.throws(() => store.transaction(() => {
      store.solanaEvent('valid', 10, { index: 1, name: 'DepositMintedEvent', data: mint });
      store.done('valid');
      throw new Error('simulated interruption');
    }));
    assert.equal(store.lastSeq(), 0);
    assert.equal(store.pendingCount(), 1);
  } finally { store.close(); }
});
test('keeps prior deposit addresses when a PDA is recreated and historical events arrive later', () => {
  const store = new Store(':memory:');
  try {
    const primary = manifest.monero.primaryAddress;
    store.account(program, 20, { name: 'DepositRecord', data: { owner: mint.owner, xmr_deposit_address: primary, created_at: '200' } });
    store.solanaEvent('old-assign', 10, { index: 1, name: 'DepositAddressAssignedEvent', data: { deposit_pda: program, xmr_address: 'older-public-subaddress' } });
    store.solanaEvent('old-create', 9, { index: 1, name: 'DepositAccountCreatedEvent', data: { deposit_pda: program, owner: mint.owner, timestamp: '100' } });
    assert.equal(store.mappings().length, 2);
    assert.equal(store.mapping('older-public-subaddress')[0].owner, mint.owner);
    assert.equal(store.mapping(primary)[0].owner, mint.owner);
  } finally { store.close(); }
});
