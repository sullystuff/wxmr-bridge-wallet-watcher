import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const manifest = JSON.parse(readFileSync(new URL('../public/mainnet.json', import.meta.url), 'utf8'));
const idlBytes = readFileSync(new URL('../public/wxmr-bridge-idl.json', import.meta.url));
if (createHash('sha256').update(idlBytes).digest('hex') !== manifest.idl.sha256) {
  throw new Error('Public IDL checksum mismatch');
}
export const idl = JSON.parse(idlBytes);
if (idl.address !== manifest.solana.programId) throw new Error('Public program identity mismatch');

function integer(env, key, fallback, min = 1, max = 1_000_000_000) {
  const value = Number(env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid ${key}`);
  return value;
}

export function endpoint(value, { loopback = false, websocket = false } = {}) {
  const url = new URL(value);
  const protocols = websocket ? ['ws:', 'wss:'] : ['http:', 'https:'];
  if (!protocols.includes(url.protocol)) throw new Error('Unsupported RPC protocol');
  if (url.username || url.password || url.hash) throw new Error('RPC userinfo and fragments are not supported');
  if (loopback && !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) {
    throw new Error('The dedicated view-wallet RPC must use a loopback address');
  }
  return url.toString();
}

export function config(env = process.env) {
  // Deliberately no key/seed settings and no reads from neighboring projects.
  const solanaUrl = endpoint(env.SOLANA_RPC_URL ?? 'https://solana-rpc.publicnode.com');
  const ws = new URL(solanaUrl);
  ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
  return {
    dataDir: resolve(env.WATCHER_DATA_DIR ?? './data'),
    solanaUrl,
    solanaWsUrl: endpoint(env.SOLANA_WS_URL ?? ws.href, { websocket: true }),
    rpcInterval: integer(env, 'SOLANA_RPC_INTERVAL_MS', 1200, 100),
    solanaPoll: integer(env, 'SOLANA_POLL_MS', 60000, 1000),
    batchSize: integer(env, 'SOLANA_BATCH_SIZE', 20, 1, 1000),
    moneroUrl: endpoint(env.MONERO_WALLET_RPC_URL ?? 'http://127.0.0.1:28088/json_rpc', { loopback: true }),
    daemonUrl: endpoint(env.MONERO_DAEMON_URL ?? 'http://127.0.0.1:18081'),
    walletBinary: env.MONERO_WALLET_RPC_BIN ?? 'monero-wallet-rpc',
    moneroPoll: integer(env, 'MONERO_POLL_MS', 30000, 1000),
    confirmations: integer(env, 'MONERO_CONFIRMATIONS', 10, 1, 10000),
    restoreHeight: integer(env, 'MONERO_RESTORE_HEIGHT', 0, 0),
    lookahead: integer(env, 'MONERO_SUBADDRESS_LOOKAHEAD', 50000, 1, 1_000_000),
    solanaOnly: env.SOLANA_ONLY === '1',
  };
}
