import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { manifest } from './config.js';
import { Rpc, stringify } from './rpc.js';
import { acquireLock } from './lock.js';

const NAME = 'wxmr-public-view';
const SETUP_METHODS = new Set(['get_version', 'generate_from_keys', 'open_wallet', 'auto_refresh', 'set_subaddress_lookahead', 'store']);

export function generationParams(config) {
  return {
    restore_height: config.restoreHeight, filename: NAME,
    address: manifest.monero.primaryAddress, viewkey: manifest.monero.publishedViewKey,
    password: '', autosave_current: false,
  };
}

async function reserveCheck(host, port) {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  await new Promise(resolve => server.close(resolve));
}

async function terminate(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const finished = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
  await finished;
  clearTimeout(timer);
}

export async function runWallet(config) {
  const url = new URL(config.moneroUrl);
  if (url.protocol !== 'http:' || url.pathname !== '/json_rpc' || url.search) throw new Error('Wallet runner requires a plain loopback /json_rpc endpoint');
  const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname;
  if (host !== '127.0.0.1') throw new Error('Wallet runner binds IPv4 loopback only');
  const port = Number(url.port || 80);
  const directory = join(config.dataDir, 'monero-view');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(directory, 'wallet-runner');
  let child;
  let stopping = false;
  const stop = () => { stopping = true; void terminate(child); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    // Never send setup calls to an existing wallet service.
    await reserveCheck(host, port);
    const markerPath = join(directory, 'public-provenance.json');
    const identity = { source: manifest.source, address: manifest.monero.primaryAddress, restoreHeight: config.restoreHeight, lookahead: config.lookahead };
    if (existsSync(join(directory, `${NAME}.keys`))) {
      if (!existsSync(markerPath) || stringify(JSON.parse(readFileSync(markerPath, 'utf8'))) !== stringify(identity)) {
        throw new Error('Existing wallet lacks matching public provenance/configuration; use a new WATCHER_DATA_DIR');
      }
    }
    const common = ['--rpc-bind-ip', host, '--rpc-bind-port', String(port), '--disable-rpc-login',
      '--non-interactive', '--no-initial-sync', '--daemon-address', config.daemonUrl, '--untrusted-daemon', '--max-concurrency', '2',
      '--shared-ringdb-dir', join(directory, 'ringdb')];
    const start = async (args, phase) => {
      const fd = openSync(join(directory, `${phase}-console.log`), 'a', 0o600);
      const spawned = spawn(config.walletBinary, [...common, '--log-file', join(directory, `${phase}.log`), ...args], {
        cwd: directory, stdio: ['ignore', fd, fd], env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
      });
      closeSync(fd);
      await new Promise((resolve, reject) => { spawned.once('spawn', resolve); spawned.once('error', () => reject(new Error('Monero wallet RPC binary could not be started'))); });
      child = spawned;
      return spawned;
    };
    const setup = await start(['--wallet-dir', directory], 'setup');
    const rpc = new Rpc(config.moneroUrl, SETUP_METHODS, { label: 'Dedicated wallet setup', timeout: 120000 });
    let ready = false;
    for (let attempt = 0; attempt < 60 && !stopping; attempt++) {
      if (setup.exitCode !== null || setup.signalCode !== null) throw new Error('Dedicated wallet process exited during startup');
      try { await rpc.call('get_version'); ready = true; break; } catch { await delay(500); }
    }
    if (!ready || stopping) throw new Error('Dedicated wallet startup interrupted or unavailable');
    if (existsSync(join(directory, `${NAME}.keys`))) {
      await rpc.call('open_wallet', { filename: NAME, password: '', autosave_current: false });
    } else {
      const result = await rpc.call('generate_from_keys', generationParams(config));
      if (result.address !== manifest.monero.primaryAddress || !/watch.only/i.test(result.info)) throw new Error('RPC did not confirm view-only wallet creation');
      writeFileSync(markerPath, `${stringify(identity)}\n`, { flag: 'wx', mode: 0o600 });
    }
    await rpc.call('auto_refresh', { enable: false });
    await rpc.call('set_subaddress_lookahead', { major_idx: 1, minor_idx: config.lookahead, password: '' });
    await rpc.call('store');
    await terminate(setup);
    if (stopping) return;
    // Normal operation exposes only the wallet RPC's restricted read methods.
    const active = await start(['--wallet-file', join(directory, NAME), '--password', '', '--restricted-rpc'], 'view-wallet');
    console.error('Dedicated view-only wallet started with restricted RPC. It is scanning from the configured restore height.');
    const code = await new Promise(resolve => active.once('exit', resolve));
    if (!stopping && code !== 0) throw new Error('Dedicated view-only wallet exited unexpectedly; see its local log');
  } finally {
    await terminate(child);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
    unlock();
  }
}
