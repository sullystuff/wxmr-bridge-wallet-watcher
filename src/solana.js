import WebSocket from 'ws';
import { manifest } from './config.js';
import { decode, decodeLogs, auditAddresses } from './codec.js';
import { Rpc, SOLANA_METHODS, safeError } from './rpc.js';

const PROGRAM = manifest.solana.programId;
const PAGE_SIZE = 100;

export class SolanaWatcher {
  constructor(config, store, rpc = new Rpc(config.solanaUrl, SOLANA_METHODS, { label: 'Solana', interval: config.rpcInterval })) {
    Object.assign(this, { config, store, rpc });
    this.verified = false;
    this.nextDiscovery = 0;
    this.nextAttempt = 0;
    this.stopped = false;
    this.socket = null;
    this.reconnectAttempt = 0;
  }
  async verifyNetwork() {
    if (await this.rpc.call('getGenesisHash', []) !== manifest.solana.genesisHash) throw new Error('Solana network identity mismatch');
    const program = await this.rpc.call('getAccountInfo', [PROGRAM, { encoding: 'base64', commitment: 'finalized' }]);
    if (!program?.value?.executable) throw new Error('Published bridge program is unavailable');
    this.verified = true;
    this.store.set('solanaNetworkVerifiedAt', new Date().toISOString());
  }
  async snapshot() {
    const result = await this.rpc.call('getProgramAccounts', [PROGRAM, { encoding: 'base64', commitment: 'finalized', withContext: true }]);
    if (!Array.isArray(result?.value) || !Number.isSafeInteger(result.context?.slot)) throw new Error('Invalid program snapshot');
    this.store.transaction(() => {
      for (const entry of result.value) this.saveAccount(entry.pubkey, result.context.slot, entry.account);
      this.store.set('snapshot', { slot: result.context.slot, accounts: result.value.length, at: new Date().toISOString() });
    });
  }
  saveAccount(address, slot, info) {
    if (!info || info.owner !== PROGRAM || info.data?.[1] !== 'base64') return;
    const bytes = Buffer.from(info.data[0], 'base64');
    if (bytes.length < 8) return;
    const account = decode(bytes, 'accounts');
    if (account) this.store.account(address, slot, account);
  }
  async signatures(before) {
    const entries = await this.rpc.call('getSignaturesForAddress', [PROGRAM, {
      commitment: 'finalized', limit: PAGE_SIZE, ...(before ? { before } : {}),
    }]);
    if (!Array.isArray(entries)) throw new Error('Invalid signature history');
    return entries;
  }
  async discoverRecent() {
    const head = this.store.get('solanaHead');
    if (!head) {
      const page = await this.signatures();
      this.store.transaction(() => {
        this.store.enqueue(page);
        if (page.length) {
          this.store.set('solanaHead', page[0].signature);
          this.store.set('backfill', { before: page.at(-1).signature, exhausted: false, oldestSlot: page.at(-1).slot });
        }
      });
      return;
    }
    const scan = this.store.get('recentScan') ?? { stop: head, before: null, newest: null };
    const page = await this.signatures(scan.before);
    const stopIndex = page.findIndex(entry => entry.signature === scan.stop);
    if (!page.length) {
      this.store.set('historyGap', { stop: scan.stop, before: scan.before, reason: 'Saved signature was not found; history may be pruned' });
      throw new Error('Solana history gap; the saved head was preserved');
    }
    scan.newest ??= page[0].signature;
    this.store.transaction(() => {
      this.store.enqueue(stopIndex >= 0 ? page.slice(0, stopIndex) : page);
      if (stopIndex >= 0) {
        this.store.set('solanaHead', scan.newest);
        this.store.set('recentScan', null);
        this.store.set('historyGap', null);
      } else {
        if (page.at(-1).signature === scan.before) throw new Error('History pagination did not advance');
        scan.before = page.at(-1).signature;
        this.store.set('recentScan', scan);
      }
    });
  }
  async backfill() {
    const cursor = this.store.get('backfill');
    if (!cursor || cursor.exhausted || this.store.pendingCount() > this.config.batchSize * 2) return;
    const page = await this.signatures(cursor.before);
    this.store.transaction(() => {
      this.store.enqueue(page);
      if (page.length && page.at(-1).signature === cursor.before) throw new Error('Backfill pagination did not advance');
      this.store.set('backfill', {
        before: page.at(-1)?.signature ?? cursor.before,
        oldestSlot: page.at(-1)?.slot ?? cursor.oldestSlot,
        exhausted: page.length === 0,
      });
    });
  }
  async processPending() {
    for (const entry of this.store.pending(this.config.batchSize)) {
      if (this.stopped) break;
      if (entry.failed) { this.store.done(entry.signature); continue; }
      try {
        const transaction = await this.rpc.call('getTransaction', [entry.signature, {
          encoding: 'jsonParsed', commitment: 'finalized', maxSupportedTransactionVersion: 0,
        }]);
        if (!transaction?.meta) {
          this.store.defer(entry.signature, 'Finalized transaction unavailable; retained for retry');
          continue;
        }
        if (transaction.slot !== entry.slot || transaction.transaction?.signatures?.[0] !== entry.signature) {
          throw new Error('Transaction identity mismatch');
        }
        if (transaction.meta.err) { this.store.done(entry.signature); continue; }
        const events = decodeLogs(transaction.meta.logMessages);
        const accounts = [];
        for (const address of auditAddresses(transaction)) {
          const info = await this.rpc.call('getAccountInfo', [address, {
            encoding: 'base64', commitment: 'finalized', minContextSlot: entry.slot,
          }]);
          if (!info?.value) throw new Error('Published audit account unavailable');
          accounts.push({ address, slot: info.context.slot, info: info.value });
        }
        this.store.transaction(() => {
          for (const event of events) this.store.solanaEvent(entry.signature, entry.slot, event);
          for (const account of accounts) this.saveAccount(account.address, account.slot, account.info);
          this.store.done(entry.signature);
        });
      } catch (error) {
        const message = error.name === 'RpcError' ? safeError(error) : 'Transaction could not be decoded or validated against the public schema';
        this.store.defer(entry.signature, message, error.retryAfter || 60000);
        if (error.name === 'RpcError') throw error;
      }
    }
  }
  async tick(force = false) {
    if (Date.now() < this.nextAttempt) return;
    try {
      if (!this.verified) await this.verifyNetwork();
      // A denied account-enumeration request must not prevent transaction watching.
      if (!this.store.get('snapshot') && Date.now() >= (this.snapshotRetryAt ?? 0)) {
        try { await this.snapshot(); this.store.set('snapshotError', null); }
        catch (error) {
          this.store.set('snapshotError', safeError(error));
          this.snapshotRetryAt = Date.now() + 300000;
          if (error.code === 'HTTP 429') throw error;
        }
      }
      if (force || Date.now() >= this.nextDiscovery || this.store.get('recentScan')) {
        await this.discoverRecent();
        this.nextDiscovery = Date.now() + this.config.solanaPoll;
      }
      await this.processPending();
      await this.backfill();
      this.store.set('solanaLastPoll', new Date().toISOString());
      this.store.set('solanaError', null);
    } catch (error) {
      this.nextAttempt = Date.now() + (error.retryAfter || 30000);
      this.store.set('solanaError', safeError(error));
    }
  }
  startStream() {
    if (this.stopped || this.socket) return;
    const socket = new WebSocket(this.config.solanaWsUrl, { handshakeTimeout: 15000, maxPayload: 2 * 1024 * 1024 });
    this.socket = socket;
    let alive = true;
    let acknowledged = false;
    const heartbeat = setInterval(() => {
      if (!alive || !acknowledged) { socket.terminate(); return; }
      alive = false;
      socket.ping();
    }, 30000);
    socket.on('open', () => socket.send(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'logsSubscribe', params: [{ mentions: [PROGRAM] }, { commitment: 'finalized' }] })));
    socket.on('pong', () => { alive = true; });
    socket.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { return; }
      if (message.id === 1 && Number.isSafeInteger(message.result)) {
        acknowledged = true;
        this.reconnectAttempt = 0;
        this.store.set('solanaStream', 'connected');
        this.nextDiscovery = 0;
      } else if (message.id === 1 && message.error) socket.terminate();
      else if (acknowledged && message.method === 'logsNotification') {
        // Notifications wake durable HTTP catch-up. They never move a cursor or prove finality.
        this.nextDiscovery = 0;
      }
    });
    socket.on('error', () => this.store.set('solanaStream', 'unavailable; HTTP catch-up remains active'));
    socket.on('close', () => {
      clearInterval(heartbeat);
      this.socket = null;
      if (this.stopped) return;
      this.store.set('solanaStream', 'reconnecting');
      this.nextDiscovery = 0;
      const delay = Math.min(60000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 6));
      this.reconnectTimer = setTimeout(() => this.startStream(), delay);
    });
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.terminate();
  }
}
