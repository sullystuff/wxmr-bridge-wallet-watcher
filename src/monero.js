import { manifest } from './config.js';
import { Rpc, MONERO_METHODS, DAEMON_METHODS, atomic, integer, safeError } from './rpc.js';

const hashPattern = /^[a-f0-9]{64}$/i;
const keyPattern = /^(?:[a-f0-9]{64})+$/i;

export function classifyProof(group, result, requiredConfirmations) {
  const received = atomic(result.received);
  const confirmations = integer(result.confirmations);
  if (typeof result.in_pool !== 'boolean') throw new Error('Invalid Monero proof response');
  // A batch can pay one address on behalf of several withdrawal records. Count the payment once.
  const reportedAmount = group.filter(row => row.purpose === 'withdrawal' && row.amount !== null)
    .reduce((sum, row) => sum + BigInt(row.amount), 0n);
  const paid = BigInt(received);
  return {
    txid: group[0].txid, address: group[0].address,
    state: paid === 0n ? 'no_payment_found' : result.in_pool || confirmations < requiredConfirmations ? 'payment_confirming' : 'payment_confirmed',
    receivedAtomic: received, confirmations, inPool: result.in_pool,
    requiredConfirmations,
    reportedWithdrawalAmountAtomic: reportedAmount.toString(),
    amountComparison: reportedAmount === 0n ? 'no_withdrawal_amount'
      : paid === reportedAmount ? 'matches_reported_total'
        : paid < reportedAmount ? 'below_reported_total' : 'above_reported_total',
    amountComparisonNote: 'Fee deductions, multiple records paying the same address, and incomplete history can affect this comparison. Payment evidence does not establish an exact allocation to each withdrawal.',
    publicSources: group.map(row => row.source),
    purposes: [...new Set(group.map(row => row.purpose))],
    checkedAt: new Date().toISOString(),
  };
}

export class MoneroWatcher {
  constructor(config, store,
    rpc = new Rpc(config.moneroUrl, MONERO_METHODS, { label: 'Monero wallet' }),
    daemon = new Rpc(new URL('/json_rpc', config.daemonUrl).href, DAEMON_METHODS, { label: 'Monero daemon' })) {
    Object.assign(this, { config, store, rpc, daemon });
    this.nextAttempt = 0;
    this.addresses = new Map([[0, manifest.monero.primaryAddress]]);
    this.mappedAddresses = new Set();
  }
  async checkCoverage() {
    const mappings = [...new Set(this.store.mappings().map(row => row.address))];
    const unresolved = [];
    // Each published address is checked once after it resolves; failures remain visible and are retried.
    for (const address of mappings) {
      if (this.mappedAddresses.has(address)) continue;
      try {
        const result = await this.rpc.call('get_address_index', { address });
        if (integer(result.index.major) !== 0) {
          unresolved.push({ address, reason: 'Outside watched account 0' }); continue;
        }
        this.addresses.set(integer(result.index.minor), address);
        this.mappedAddresses.add(address);
      } catch (error) {
        if (error.code !== 'RPC -2') throw error;
        unresolved.push({ address, reason: 'Not found within this view wallet; increase lookahead and rescan in a new data directory' });
      }
    }
    this.store.set('moneroAddressCoverage', { publishedAddresses: mappings.length, resolved: this.mappedAddresses.size, unresolved });
  }
  async scanReceipts() {
    // Check identity every scan: an externally replaced RPC wallet must not silently change the feed.
    const address = await this.rpc.call('get_address', { account_index: 0, address_index: [0] });
    if (address.address !== manifest.monero.primaryAddress) throw new Error('View wallet is not the published wXMR wallet');
    const info = await this.daemon.call('get_info');
    if (info.nettype !== 'mainnet' || info.offline === true || info.synchronized !== true) throw new Error('Monero mainnet daemon is not synchronized');
    await this.checkCoverage();
    const heightBefore = integer((await this.rpc.call('get_height')).height);
    const outputs = await this.rpc.call('incoming_transfers', { transfer_type: 'all', account_index: 0 });
    if (outputs.transfers !== undefined && !Array.isArray(outputs.transfers)) throw new Error('Invalid incoming output list');
    const heightAfter = integer((await this.rpc.call('get_height')).height);
    // Avoid applying a removal snapshot across a wallet refresh/reorg boundary.
    if (heightBefore !== heightAfter) {
      this.store.set('moneroSync', { walletHeight: heightAfter, daemonHeight: integer(info.height), state: 'refreshing; snapshot will be retried' });
      return;
    }
    const receipts = [];
    const ids = new Set();
    for (const output of outputs.transfers ?? []) {
      if (!hashPattern.test(output.tx_hash) || !hashPattern.test(output.pubkey)) throw new Error('Invalid Monero output identity');
      const major = integer(output.subaddr_index.major);
      const minor = integer(output.subaddr_index.minor);
      if (major !== 0) throw new Error('Unexpected wallet account');
      if (!this.addresses.has(minor)) {
        const found = await this.rpc.call('get_address', { account_index: 0, address_index: [minor] });
        const subaddress = found.addresses?.find(entry => entry.address_index === minor)?.address;
        if (!subaddress) throw new Error('Incoming output address could not be resolved');
        this.addresses.set(minor, subaddress);
      }
      const blockHeight = integer(output.block_height);
      if (blockHeight >= heightAfter) throw new Error('Output is ahead of the view-wallet scan');
      const confirmations = heightAfter - blockHeight;
      const txid = output.tx_hash.toLowerCase();
      const outputPublicKey = output.pubkey.toLowerCase();
      const id = `${txid}:${outputPublicKey}`;
      if (ids.has(id)) throw new Error('Duplicate output identity in wallet response');
      ids.add(id);
      const receiptAddress = this.addresses.get(minor);
      receipts.push({
        txid, outputPublicKey, address: receiptAddress, amountAtomic: atomic(output.amount),
        subaddressIndex: { major, minor }, blockHeight, confirmations,
        state: confirmations >= this.config.confirmations ? 'confirmed' : 'confirming',
        ...this.store.receiptContext(txid, receiptAddress),
        spendStatus: 'unknown_from_view_key',
      });
    }
    this.store.transaction(() => {
      this.store.saveReceipts(receipts, heightAfter);
      this.store.set('moneroSync', {
        walletHeight: heightAfter, daemonHeight: integer(info.height),
        state: heightAfter >= integer(info.height) ? 'caught_up' : 'syncing',
        restoreHeight: this.config.restoreHeight, lookahead: this.config.lookahead,
      });
    });
  }
  async verifyProofs() {
    for (const group of this.store.proofGroups(Date.now(), this.config.batchSize)) {
      const first = group[0];
      const keys = [...new Set(group.map(row => row.tx_key).filter(key => keyPattern.test(key) && key.length <= 64 * 256))];
      if (!hashPattern.test(first.txid) || !keys.length) {
        this.store.saveProof(group, { state: 'public_proof_unavailable', txid: first.txid, address: first.address, publicSources: group.map(row => row.source) }, 300000);
        continue;
      }
      let proof = null;
      let lastError = null;
      for (const key of keys) {
        try {
          const result = await this.rpc.call('check_tx_key', { txid: first.txid, address: first.address, tx_key: key });
          const checked = classifyProof(group, result, this.config.confirmations);
          if (!proof || BigInt(checked.receivedAtomic) > BigInt(proof.receivedAtomic)) proof = checked;
        } catch (error) { lastError = error; }
      }
      if (!proof) {
        this.store.saveProof(group, {
          state: 'verification_unavailable', txid: first.txid, address: first.address,
          error: safeError(lastError), publicSources: group.map(row => row.source),
        }, 60000);
        if (lastError?.code === 'transport unavailable' || lastError?.retryAfter) throw lastError;
      } else {
        // Recheck confirmed proofs too; a Monero reorg can revoke earlier evidence.
        this.store.saveProof(group, proof, proof.state === 'payment_confirmed' ? 300000 : this.config.moneroPoll);
      }
    }
  }
  async tick(force = false) {
    if (!force && Date.now() < this.nextAttempt) return;
    this.nextAttempt = Date.now() + this.config.moneroPoll;
    try {
      await this.scanReceipts();
      await this.verifyProofs();
      this.store.set('moneroError', null);
      this.store.set('moneroLastPoll', new Date().toISOString());
    } catch (error) {
      this.store.set('moneroError', safeError(error));
      this.nextAttempt = Date.now() + Math.max(this.config.moneroPoll, error.retryAfter || 0);
    }
  }
}
