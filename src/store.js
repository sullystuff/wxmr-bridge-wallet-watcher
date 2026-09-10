import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { manifest } from './config.js';
import { parseJson, stringify, atomic } from './rpc.js';

export const fingerprint = value => createHash('sha256').update(stringify(value)).digest('hex');

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS queue (
        ordinal INTEGER PRIMARY KEY AUTOINCREMENT, signature TEXT NOT NULL UNIQUE,
        slot INTEGER NOT NULL, block_time INTEGER, failed INTEGER NOT NULL,
        done INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0, error TEXT
      );
      CREATE INDEX IF NOT EXISTS queue_pending ON queue(done, retry_at, slot);
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
        chain TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT,
        slot INTEGER, signature TEXT, data TEXT NOT NULL,
        observed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE INDEX IF NOT EXISTS events_subject ON events(subject, kind);
      CREATE TABLE IF NOT EXISTS accounts (
        address TEXT PRIMARY KEY, kind TEXT NOT NULL, slot INTEGER NOT NULL, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mappings (
        address TEXT NOT NULL, pda TEXT NOT NULL, owner TEXT, source TEXT NOT NULL,
        PRIMARY KEY(address, pda)
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, txid TEXT NOT NULL, address TEXT NOT NULL, data TEXT NOT NULL, seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS proofs (
        id TEXT PRIMARY KEY, purpose TEXT NOT NULL, txid TEXT NOT NULL, address TEXT NOT NULL,
        tx_key TEXT NOT NULL, source TEXT NOT NULL, amount TEXT, data TEXT,
        checked_at INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
      );
    `);
    const identity = `${manifest.solana.genesisHash}:${manifest.solana.programId}:${manifest.monero.primaryAddress}`;
    if (this.get('identity') && this.get('identity') !== identity) throw new Error('Database belongs to another bridge');
    this.set('identity', identity);
    this.set('schemaVersion', 1);
  }
  close() { this.db.close(); }
  get(key) {
    const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return row ? JSON.parse(row.value) : null;
  }
  set(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, stringify(value)); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  emit(id, chain, kind, subject, data, slot = null, signature = null) {
    return this.db.prepare('INSERT OR IGNORE INTO events(id,chain,kind,subject,slot,signature,data) VALUES (?,?,?,?,?,?,?)')
      .run(id, chain, kind, subject, slot, signature, stringify(data)).changes > 0;
  }
  events(after = 0, limit = 1000) {
    return this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit)
      .map(row => ({ ...row, data: JSON.parse(row.data) }));
  }
  lastSeq() { return this.db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM events').get().n; }
  enqueue(entries) {
    const insert = this.db.prepare('INSERT OR IGNORE INTO queue(signature,slot,block_time,failed) VALUES (?,?,?,?)');
    for (const entry of entries) {
      if (!Number.isSafeInteger(entry.slot) || typeof entry.signature !== 'string') throw new Error('Invalid signature history');
      insert.run(entry.signature, entry.slot, entry.blockTime ?? null, entry.err ? 1 : 0);
    }
  }
  pending(limit, now = Date.now()) {
    // Signatures arrive newest first; descending discovery order resolves same-slot ties.
    return this.db.prepare('SELECT * FROM queue WHERE done=0 AND retry_at<=? ORDER BY slot,ordinal DESC LIMIT ?').all(now, limit);
  }
  pendingCount() { return this.db.prepare('SELECT count(*) AS n FROM queue WHERE done=0').get().n; }
  done(signature) { this.db.prepare('UPDATE queue SET done=1,error=NULL WHERE signature=?').run(signature); }
  defer(signature, error, ms = 60000) {
    this.db.prepare('UPDATE queue SET error=?,retry_at=? WHERE signature=?').run(error, Date.now() + ms, signature);
  }
  mapAddress(address, pda, owner, source) {
    if (!address) return;
    this.db.prepare(`INSERT INTO mappings VALUES (?,?,?,?) ON CONFLICT(address,pda)
      DO UPDATE SET owner=COALESCE(mappings.owner,excluded.owner)`).run(address, pda, owner ?? null, source);
  }
  mappings() { return this.db.prepare('SELECT * FROM mappings ORDER BY address,pda').all(); }
  mapping(address) { return this.db.prepare('SELECT * FROM mappings WHERE address=?').all(address); }
  account(address, slot, { name, data }) {
    this.db.prepare(`INSERT INTO accounts VALUES (?,?,?,?) ON CONFLICT(address)
      DO UPDATE SET kind=excluded.kind,slot=excluded.slot,data=excluded.data WHERE excluded.slot>=accounts.slot`)
      .run(address, name, slot, stringify(data));
    if (name === 'DepositRecord') this.mapAddress(data.xmr_deposit_address, address, data.owner, `account:${address}@${slot}`);
    if (name === 'AuditRecord') this.auditProofs(address, slot, data);
  }
  solanaEvent(signature, slot, event) {
    const { name, data, index } = event;
    const subject = data.deposit_pda ?? data.withdrawal_pda ?? null;
    if (!this.emit(`solana:${signature}:${index}`, 'solana', name, subject, data, slot, signature)) return;
    if (data.deposit_pda && data.owner) {
      this.db.prepare('UPDATE mappings SET owner=COALESCE(owner,?) WHERE pda=?').run(data.owner, data.deposit_pda);
    }
    if (name === 'DepositAddressAssignedEvent') {
      const ownerEvent = this.db.prepare(`SELECT data FROM events WHERE subject=? AND kind IN
        ('DepositAccountCreatedEvent','DepositMintedEvent') ORDER BY slot DESC LIMIT 1`).get(data.deposit_pda);
      this.mapAddress(data.xmr_address, data.deposit_pda, ownerEvent ? JSON.parse(ownerEvent.data).owner : null, `transaction:${signature}`);
    }
    if (name === 'WithdrawCompletedEvent') {
      this.addProof(`withdrawal:${signature}:${index}`, 'withdrawal', data.xmr_tx_hash, data.xmr_address,
        data.xmr_tx_key, `transaction:${signature}#log:${index}`, data.amount);
    }
  }
  addProof(id, purpose, txid, address, key, source, amount = null) {
    // Inputs only enter here from program-owned finalized accounts or successful bridge events.
    if (typeof txid !== 'string' || typeof address !== 'string' || typeof key !== 'string') return;
    this.db.prepare(`INSERT OR IGNORE INTO proofs(id,purpose,txid,address,tx_key,source,amount) VALUES (?,?,?,?,?,?,?)`)
      .run(id, purpose, txid, address, key, source, amount === null ? null : atomic(amount));
  }
  auditProofs(address, slot, data) {
    let audit;
    try { audit = parseJson(data.data); }
    catch { this.set(`auditIncomplete:${address}`, { slot, reason: 'Audit JSON is incomplete or invalid' }); return; }
    if (!Array.isArray(audit.txs) || typeof audit.address !== 'string') return;
    this.set(`auditIncomplete:${address}`, null);
    for (const tx of audit.txs) {
      this.addProof(`audit:${address}:${tx.txid}`, 'consolidation', tx.txid, audit.address, tx.key,
        `account:${address}@${slot}`, tx.amount ?? null);
    }
  }
  proofGroups(now = Date.now(), limit = 20) {
    const rows = this.db.prepare('SELECT * FROM proofs WHERE retry_at<=? ORDER BY checked_at,id').all(now);
    const groups = new Map();
    for (const row of rows) {
      const key = `${row.txid}:${row.address}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    // Include already-checked members so batch totals never depend on retry timing.
    return [...groups.keys()].slice(0, limit).map(key => {
      const first = groups.get(key)[0];
      return this.db.prepare('SELECT * FROM proofs WHERE txid=? AND address=? ORDER BY id').all(first.txid, first.address);
    });
  }
  saveProof(group, result, interval) {
    const now = Date.now();
    for (const row of group) this.db.prepare('UPDATE proofs SET data=?,checked_at=?,retry_at=? WHERE id=?')
      .run(stringify(result), now, now + interval, row.id);
    const { confirmations, checkedAt, ...stable } = result;
    this.emit(`proof:${group[0].txid}:${group[0].address}:${fingerprint(stable)}`, 'monero', 'PaymentProofChecked', group[0].txid, result);
  }
  saveReceipts(receipts, height) {
    const seen = (this.get('receiptScan') ?? 0) + 1;
    this.set('receiptScan', seen);
    for (const receipt of receipts) {
      const id = `${receipt.txid}:${receipt.outputPublicKey}`;
      const prior = this.db.prepare('SELECT data FROM receipts WHERE id=?').get(id);
      const { confirmations, ...stable } = receipt;
      this.db.prepare(`INSERT INTO receipts VALUES (?,?,?,?,?,?) ON CONFLICT(id)
        DO UPDATE SET address=excluded.address,data=excluded.data,seen=excluded.seen`)
        .run(id, receipt.txid, receipt.address, stringify(receipt), seen);
      // Reappearances after a reorg must be observable even when values are unchanged.
      const revision = prior && JSON.parse(prior.data).state === 'not_in_latest_scan' ? `:${seen}` : '';
      this.emit(`receipt:${id}:${fingerprint(stable)}${revision}`, 'monero', 'IncomingOutputObserved', receipt.txid, receipt);
    }
    for (const row of this.db.prepare('SELECT * FROM receipts WHERE seen<>?').all(seen)) {
      const previous = JSON.parse(row.data);
      if (previous.state === 'not_in_latest_scan') continue;
      const receipt = { ...previous, state: 'not_in_latest_scan', confirmations: 0 };
      this.db.prepare('UPDATE receipts SET data=? WHERE id=?').run(stringify(receipt), row.id);
      this.emit(`receipt-missing:${row.id}:${seen}`, 'monero', 'IncomingOutputMissing', row.txid, receipt);
    }
    this.set('moneroHeight', height);
  }
  receiptContext(txid, address) {
    const purposes = this.db.prepare('SELECT DISTINCT purpose FROM proofs WHERE txid=?').all(txid).map(row => row.purpose);
    return {
      mappings: this.mapping(address),
      publishedTransactionPurposes: purposes,
      classification: purposes.includes('consolidation') ? 'published_consolidation_receipt'
        : purposes.includes('withdrawal') ? 'published_withdrawal_receipt'
          : address === manifest.monero.primaryAddress ? 'primary_address_receipt'
            : this.mapping(address).length ? 'assigned_deposit_address_receipt' : 'unmapped_receipt',
    };
  }
  status() {
    const meta = Object.fromEntries(this.db.prepare('SELECT * FROM meta ORDER BY key').all().map(row => [row.key, JSON.parse(row.value)]));
    const counts = {};
    for (const table of ['events', 'accounts', 'mappings', 'receipts', 'proofs']) counts[table] = this.db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
    return {
      ...meta, counts, pendingSolanaTransactions: this.pendingCount(),
      unresolvedSolanaTransactions: this.db.prepare('SELECT signature,slot,error FROM queue WHERE done=0 AND error IS NOT NULL LIMIT 20').all(),
      moneroReceiptStates: this.db.prepare("SELECT json_extract(data,'$.state') AS state,count(*) AS count FROM receipts GROUP BY state").all(),
      proofStates: this.db.prepare("SELECT json_extract(data,'$.state') AS state,count(*) AS count FROM proofs GROUP BY state").all(),
      coverage: {
        historicalSolanaCoverage: 'Limited to the history retained by the configured provider; see backfill and unresolved transactions',
        monero: 'Account 0 and discovered subaddresses from the configured restore height',
        reserveBalance: 'Not calculated: a view key does not identify all spent outputs',
        mintMatching: 'Mint events report aggregate credits; they do not identify a Monero transaction',
      },
    };
  }
}
