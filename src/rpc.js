import JSONbigFactory from 'json-bigint';
import { setTimeout as delay } from 'node:timers/promises';

// Long numeric tokens stay strings. Solana also includes decimal uiAmount fields,
// which cannot be parsed as BigInt; accounting consumes only integer atomic fields.
const json = JSONbigFactory({ storeAsString: true, protoAction: 'error', constructorAction: 'error' });
export const parseJson = text => json.parse(text);
export const stringify = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
export const safeError = error => error instanceof RpcError ? error.message : 'Operation failed; no RPC response or credentials logged';

export class RpcError extends Error {
  constructor(label, method, code, retryAfter = 0) {
    super(`${label} ${method}: ${code}`);
    this.name = 'RpcError';
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export const SOLANA_METHODS = new Set(['getGenesisHash', 'getSlot', 'getSignaturesForAddress', 'getTransaction', 'getAccountInfo', 'getMultipleAccounts', 'getProgramAccounts']);
export const MONERO_METHODS = new Set(['get_address', 'get_address_index', 'get_height', 'incoming_transfers', 'get_transfers', 'check_tx_key']);
export const DAEMON_METHODS = new Set(['get_info']);

export class Rpc {
  constructor(url, methods, { label = 'RPC', interval = 0, timeout = 30000, fetchImpl = fetch } = {}) {
    Object.assign(this, { url, methods, label, interval, timeout, fetchImpl });
    this.tail = Promise.resolve();
    this.nextAt = 0;
    this.counter = 0;
    this.controller = new AbortController();
  }

  close() { this.controller.abort(); }

  call(method, params = {}) {
    if (!this.methods.has(method)) return Promise.reject(new Error(`RPC method is not allowed: ${method}`));
    const task = this.tail.then(async () => {
      if (this.controller.signal.aborted) throw new RpcError(this.label, method, 'stopped');
      const wait = this.nextAt - Date.now();
      if (wait > 0) {
        try { await delay(wait, undefined, { signal: this.controller.signal }); }
        catch { throw new RpcError(this.label, method, 'stopped'); }
      }
      this.nextAt = Date.now() + this.interval;
      let response;
      const id = ++this.counter;
      try {
        response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'user-agent': 'wxmr-public-watcher/0.1' },
          body: stringify({ jsonrpc: '2.0', id, method, params }),
          signal: AbortSignal.any([AbortSignal.timeout(this.timeout), this.controller.signal]),
          redirect: 'error',
        });
      } catch { throw new RpcError(this.label, method, 'transport unavailable'); }
      if (!response.ok) {
        const retrySeconds = Number(response.headers.get('retry-after'));
        const retryAfter = response.status === 429 ? Math.max(60000, Math.min(300000, retrySeconds * 1000 || 0)) : 10000;
        this.nextAt = Math.max(this.nextAt, Date.now() + retryAfter);
        throw new RpcError(this.label, method, `HTTP ${response.status}`, retryAfter);
      }
      let result;
      try { result = parseJson(await response.text()); }
      catch { throw new RpcError(this.label, method, 'invalid JSON'); }
      if (result.id !== id || result.jsonrpc !== '2.0') throw new RpcError(this.label, method, 'invalid response identity');
      if (result.error) throw new RpcError(this.label, method, `RPC ${result.error.code}`);
      if (!Object.hasOwn(result, 'result')) throw new RpcError(this.label, method, 'missing result');
      return result.result;
    });
    this.tail = task.catch(() => {});
    return task;
  }
}

export function atomic(value) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Imprecise atomic amount');
  if (!/^(0|[1-9][0-9]*)$/.test(String(value))) throw new Error('Invalid atomic amount');
  return BigInt(value).toString();
}

export function integer(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid nonnegative integer');
  return n;
}
