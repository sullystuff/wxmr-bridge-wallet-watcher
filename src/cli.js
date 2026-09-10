#!/usr/bin/env node
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { config } from './config.js';
import { Store } from './store.js';
import { SolanaWatcher } from './solana.js';
import { MoneroWatcher } from './monero.js';
import { runWallet } from './wallet.js';
import { acquireLock } from './lock.js';
import { stringify, safeError } from './rpc.js';

async function main() {
  const command = process.argv[2] ?? 'help';
  if (command === 'help' || command === '--help') {
    console.log(`wXMR public wallet watcher

  wallet   Run a separate Monero view-only wallet with restricted local RPC
  watch    Stream finalized bridge activity and check Monero receipts/proofs
  once     Perform one bounded synchronization pass and print status
  status   Show local synchronization, coverage, and verification status
  events   Export durable JSONL events; optionally --after <sequence>

Configuration: .env.example (opt in with node --env-file=.env).
Runtime files default to ./data. Only public bridge/view/proof data is used.`);
    return;
  }
  const cfg = config();
  if (command === 'wallet') { await runWallet(cfg); return; }
  if (!['watch', 'once', 'status', 'events'].includes(command)) throw new Error('Unknown command; run node src/cli.js help');
  const path = join(cfg.dataDir, 'watcher.sqlite');
  if (['status', 'events'].includes(command) && !existsSync(path)) throw new Error('No local history yet; run once or watch first');
  const unlock = ['watch', 'once'].includes(command) ? acquireLock(cfg.dataDir, 'watcher') : () => {};
  let store;
  let solana;
  let stopping = false;
  const stop = () => { stopping = true; solana?.stop(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    store = new Store(path);
    if (command === 'status') { console.log(JSON.stringify(store.status(), null, 2)); return; }
    if (command === 'events') {
      let after = 0;
      if (process.argv[3] === '--after') after = Number(process.argv[4]);
      if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event sequence');
      for (;;) {
        const rows = store.events(after);
        if (!rows.length) break;
        for (const event of rows) console.log(stringify(event));
        after = rows.at(-1).seq;
      }
      return;
    }
    solana = new SolanaWatcher(cfg, store);
    const monero = new MoneroWatcher(cfg, store);
    store.set('moneroEnabled', !cfg.solanaOnly);
    let sequence = store.lastSeq();
    if (command === 'watch') solana.startStream();
    console.error(cfg.solanaOnly ? 'Watching finalized Solana records; Monero checks explicitly disabled.' : 'Watching finalized Solana records and public Monero receipts/proofs.');
    let nextStatus = 0;
    do {
      // Separate chains can progress independently; all database writes are synchronous transactions.
      await Promise.all([solana.tick(command === 'once'), ...(cfg.solanaOnly ? [] : [monero.tick(command === 'once')])]);
      for (;;) {
        const events = store.events(sequence);
        if (!events.length) break;
        for (const event of events) console.log(stringify(event));
        sequence = events.at(-1).seq;
      }
      if (Date.now() >= nextStatus) {
        const status = store.status();
        console.error(stringify({ type: 'watcher_status', solanaError: status.solanaError, moneroError: status.moneroError,
          queued: status.pendingSolanaTransactions, moneroSync: status.moneroSync, stream: status.solanaStream }));
        nextStatus = Date.now() + 60000;
      }
      if (command === 'once') {
        console.error(JSON.stringify(store.status(), null, 2));
        if (store.get('solanaError') || (!cfg.solanaOnly && store.get('moneroError'))) process.exitCode = 1;
        break;
      }
      if (!stopping) await delay(1000);
    } while (!stopping);
  } finally {
    solana?.stop();
    store?.close();
    unlock();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

main().catch(error => {
  // Only local validation errors and sanitized RPC summaries are shown.
  console.error(error.name === 'RpcError' ? safeError(error) : error.message.replace(/https?:\/\/\S+/g, '[RPC endpoint]'));
  process.exitCode = 1;
});
