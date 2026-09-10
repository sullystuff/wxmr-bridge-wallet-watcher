#!/usr/bin/env bash
# Personal launcher. Uses only the public view wallet created by this repository.
set -Eeuo pipefail
umask 077

watcher_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$watcher_root"
export WATCHER_DATA_DIR="${WATCHER_DATA_DIR:-$watcher_root/data/personal}"
export MONERO_RESTORE_HEIGHT="${MONERO_RESTORE_HEIGHT:-3756000}"
export MONERO_SUBADDRESS_LOOKAHEAD="${MONERO_SUBADDRESS_LOOKAHEAD:-50000}"
export MONERO_WALLET_RPC_URL="${MONERO_WALLET_RPC_URL:-http://127.0.0.1:28088/json_rpc}"
export MONERO_DAEMON_URL="${MONERO_DAEMON_URL:-http://127.0.0.1:18081}"

watcher_command="${1:-run}"
if (( $# )); then shift; fi
case "$watcher_command" in
  -h|--help|help)
    cat <<'HELP'
./watch.sh                 Start the public view wallet and watcher; Ctrl-C stops both.
./watch.sh status          Show this launcher's local status.
./watch.sh events          Export its saved JSONL events (supports --after SEQUENCE).

If the test is already running in screen, attach with:
  screen -r wxmr-watcher-test
Press Ctrl-C in that session to stop both components before starting a new run.

Defaults: data/personal, local Monero daemon, wallet RPC port 28088,
and Monero history from block 3756000. Environment variables override defaults.
For all Monero history, use a fresh data directory and MONERO_RESTORE_HEIGHT=0.
The script does not load .env files or start the Monero daemon.
HELP
    exit 0 ;;
  status|events) exec node src/cli.js "$watcher_command" "$@" ;;
  run) if (( $# )); then echo 'Use ./watch.sh --help for usage.' >&2; exit 2; fi ;;
  *) echo 'Use ./watch.sh --help for usage.' >&2; exit 2 ;;
esac

if [[ -z "${MONERO_WALLET_RPC_BIN:-}" ]]; then
  if command -v monero-wallet-rpc >/dev/null 2>&1; then
    MONERO_WALLET_RPC_BIN="$(command -v monero-wallet-rpc)"
  elif [[ -x "$HOME/monero/monero-wallet-rpc" ]]; then
    MONERO_WALLET_RPC_BIN="$HOME/monero/monero-wallet-rpc"
  else
    echo 'Set MONERO_WALLET_RPC_BIN to your monero-wallet-rpc executable.' >&2
    exit 1
  fi
fi
export MONERO_WALLET_RPC_BIN

mkdir -p "$WATCHER_DATA_DIR"
exec 9>>"$WATCHER_DATA_DIR/personal-launcher.lock"
if ! flock -n 9; then
  cat >&2 <<'RUNNING'
The personal watcher is already running in this data directory.
For the background test, attach with: screen -r wxmr-watcher-test
Press Ctrl-C there to stop both components, then run ./watch.sh again.
To find the launcher, use: pgrep -af '[w]atch.sh'
The underlying processes are named bash and node, so plain pgrep watcher misses them.
RUNNING
  exit 1
fi
if [[ ! -d node_modules ]]; then npm ci --ignore-scripts --no-audit --no-fund >&2; fi

wallet_pid=''
watcher_pid=''
cleanup() {
  trap - EXIT INT TERM
  # Only child jobs created by this invocation can be stopped here.
  local running_pid
  for running_pid in $(jobs -pr); do
    if [[ "$running_pid" == "$watcher_pid" || "$running_pid" == "$wallet_pid" ]]; then
      kill -TERM "$running_pid" 2>/dev/null || true
    fi
  done
  [[ -z "$watcher_pid" ]] || wait "$watcher_pid" 2>/dev/null || true
  [[ -z "$wallet_pid" ]] || wait "$wallet_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

echo "Starting public view wallet; Monero scan starts at block $MONERO_RESTORE_HEIGHT." >&2
echo "Wallet startup log: $WATCHER_DATA_DIR/wallet-runner.log" >&2
node src/cli.js wallet >"$WATCHER_DATA_DIR/wallet-runner.log" 2>&1 &
wallet_pid=$!

# Wait for our wallet child, checking the published address without exporting keys.
node --input-type=module - "$wallet_pid" <<'JS'
import { setTimeout as delay } from 'node:timers/promises';
import { config, manifest } from './src/config.js';
import { Rpc, MONERO_METHODS } from './src/rpc.js';
const rpc = new Rpc(config().moneroUrl, MONERO_METHODS, { timeout: 2000 });
const pid = Number(process.argv[2]);
let ready = false;
for (let attempt = 0; attempt < 120; attempt++) {
  try { process.kill(pid, 0); } catch { break; }
  try {
    const wallet = await rpc.call('get_address', { account_index: 0, address_index: [0] });
    if (wallet.address !== manifest.monero.primaryAddress) throw new Error('Different wallet');
    ready = true;
    break;
  } catch { await delay(1000); }
}
rpc.close();
if (!ready) { console.error('View wallet did not start. See the wallet startup log.'); process.exitCode = 1; }
JS

echo 'Starting watcher. Ctrl-C stops this watcher and its view wallet.' >&2
node src/cli.js watch &
watcher_pid=$!
if wait -n "$wallet_pid" "$watcher_pid"; then
  echo 'One watcher component exited; stopping the other.' >&2
  exit 1
else
  exit "$?"
fi
