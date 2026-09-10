# wXMR public wallet watcher

An independent observer of wXMR deposits and withdrawals using information published at [wxmr.io/transparency](https://wxmr.io/transparency) and by its Solana bridge program.

The only bundled key is the **published Monero view key**. Its public source, retrieval time, program identity, and the public IDL checksum are recorded in `public/mainnet.json`. No spend key, seed, Solana signing key, production database, or production environment file is used.

## Personal launcher

```sh
./watch.sh
```

This starts the view wallet and watcher together. Ctrl-C stops both. It finds `monero-wallet-rpc` on your PATH or at `$HOME/monero/monero-wallet-rpc`, uses the local mainnet daemon, and keeps state in `data/personal/`. The default Monero scan starts at **3,756,000** for the personal test; Solana history continues to backfill. Use `./watch.sh status` or `./watch.sh events` from another terminal. Environment variables override these defaults; the launcher does not read `.env` automatically.

For a fresh scan of all Monero history: `WATCHER_DATA_DIR=./data/full MONERO_RESTORE_HEIGHT=0 ./watch.sh`.

## Run

Requirements: Node.js **22.13 or newer**, an official `monero-wallet-rpc` binary supporting `set_subaddress_lookahead`, a synchronized mainnet Monero daemon, and Solana HTTP/WebSocket access. The defaults use public Solana RPC and a Monero daemon at `127.0.0.1:18081`. No paid RPC credential is required. Node 22 may print its standard experimental SQLite warning.

```sh
npm ci
cp .env.example .env
```

Set `MONERO_WALLET_RPC_BIN` in `.env` to your Monero binary and `MONERO_DAEMON_URL` to your mainnet daemon. The example contains only public URLs and configuration; do not put wallet secrets in it.

In one terminal, start the dedicated view wallet:

```sh
node --env-file=.env src/cli.js wallet
```

In another terminal, start the watcher:

```sh
node --env-file=.env src/cli.js watch
```

The wallet command creates a **new view-only wallet** from the pinned, website-published address and view key. It sets account 0's subaddress lookahead, saves the wallet, then runs `monero-wallet-rpc` in **restricted mode** on `127.0.0.1:28088`. It refuses an occupied port and keeps its wallet, logs, and ring database under `data/monero-view/`. It never opens a bridge operator's wallet or contacts the bridge backend. Ctrl-C stops only its own child process.

`MONERO_RESTORE_HEIGHT=0` scans all Monero history and can take substantial time. A higher restore height is an explicit coverage limit. Default lookahead is 50,000 subaddresses in account 0. Published deposit addresses outside the wallet's lookahead appear under `moneroAddressCoverage.unresolved`; increase lookahead and use a new data directory to rescan. A changed restore height/lookahead requires a fresh wallet directory to avoid claiming coverage that an existing scan does not have.

`npm start`, `npm run wallet`, `npm run once`, and `npm run status` also work when configuration is exported in your shell. These npm shortcuts do **not** load `.env` automatically.

For Solana alone:

```sh
SOLANA_ONLY=1 npm start
```

## Inspect and consume activity

```sh
node --env-file=.env src/cli.js once
node --env-file=.env src/cli.js status
node --env-file=.env src/cli.js events --after 0
```

`watch` writes JSONL activity to stdout and status/errors to stderr. `events` exports the durable event log from SQLite; `--after` resumes after the last sequence number consumed. Save output outside tracked source, for example `node src/cli.js events > data/events.jsonl`.

Each event has a monotonic `seq`, stable `id`, `chain`, `kind`, `subject`, optional Solana `slot`/`signature`, and `data`. **Amounts are decimal strings in atomic units** (1 XMR = 1,000,000,000,000 atomic units). They never pass through floating-point conversion.

| Activity | Meaning |
| --- | --- |
| `DepositAccountCreatedEvent`, `DepositAddressAssignedEvent` | A public Solana owner/deposit-address association |
| `IncomingOutputObserved` | An individual mined Monero output detected with the published view key; includes address, amount, confirmations, and any known Solana mapping |
| `IncomingOutputMissing` | A previously observed output is absent from a successful later wallet scan; can indicate a reorg or rescan |
| `DepositMintedEvent` | Finalized wXMR mint amount and cumulative deposit total reported by the bridge program |
| `WithdrawRequestedEvent`, `WithdrawRevertedEvent` | Finalized withdrawal request/burn or reversal |
| `WithdrawCompletedEvent` | The program published a completion with a Monero transaction hash and proof key |
| `PaymentProofChecked` | Independent `check_tx_key` result: actual amount received, Monero confirmations, and links to its public proof sources |

`payment_confirmed` means a positive payment to the published destination was found outside the pool with at least `MONERO_CONFIRMATIONS` confirmations (default 10). It does **not** mean the requested amount was paid exactly: inspect `receivedAtomic`, `reportedWithdrawalAmountAtomic`, and `amountComparison`. Fees can be deducted from withdrawals. Several withdrawal records may share one transaction and destination, so the watcher checks that payment once and compares the aggregate reported amount. It makes no unsupported allocation to individual records.

Missing keys stay `public_proof_unavailable`; RPC failures stay `verification_unavailable`. Proofs with no positive receipt are `no_payment_found`. Confirmed proofs are checked again every five minutes so later changes remain visible. Public consolidation audit transaction keys are also checked and used to label internal receipts separately from ordinary deposit-address receipts.

## Recovery and coverage

The watcher uses finalized `logsSubscribe` notifications to wake paced HTTP catch-up. HTTP discovery also runs periodically, covering disconnects and missed notifications. Notifications alone never establish finality or move the saved cursor. Only successful bridge program invocations supply events, including CPI; event-shaped logs from other programs and failed nested invocations are ignored.

Signatures are queued durably before the discovery cursor advances. Processing a transaction and recording its events is one SQLite transaction. Unavailable or undecodable transactions stay queued for retry. History gaps are reported. New activity has priority over older backfill so initial history scanning cannot indefinitely delay live withdrawals. Old history is fetched in bounded pages whenever the queue has capacity.

A program-account snapshot is attempted at startup to seed public mappings and audit records. Providers that deny it remain usable through transaction history; `snapshotError` makes that reduced initial coverage visible. The snapshot is not repeatedly polled. `getAccountInfo` retrieves audit accounts when their creation/extension appears in transaction history.

Check `pendingSolanaTransactions`, `unresolvedSolanaTransactions`, `backfill`, `snapshotError`, `moneroSync`, `moneroAddressCoverage`, and chain errors in `status`. `once` performs one bounded pass; a successful exit does **not** mean all historical records have been scanned. Backfill exhaustion means the configured provider returned no more history, not proof that it retained the bridge's entire lifetime.

Deposit-address mappings are retained when a deposit PDA is closed/recreated. Mint events do not contain a Monero transaction hash, so the watcher records receipts and aggregate mint credits without inventing an exact receipt-to-mint match. It starts reporting Monero receipts once they are mined; there is no mempool receipt feed.

The view key does **not** reliably identify outgoing spends or the current reserve balance. Outputs are labeled `spendStatus: unknown_from_view_key`. Public payout proofs establish payment to an address, not its current spendability, and do not prove the absence of unpublished outgoing transactions. This watcher makes no reserve-balance or solvency claim.

State lives in `data/watcher.sqlite` with WAL and full synchronous commits. Single-process locks prevent two writers using the same data directory. After an unclean exit, check the recorded PID has exited before removing only the relevant stale lock (`data/watcher.lock` or `data/monero-view/wallet-runner.lock`). Do not remove wallet/SQLite files to resolve a lock. Use the same environment file and data directory when restarting.

## Public-source and implementation checks

```sh
npm test
npm run check:public
npm run verify:public
npm audit --omit=dev
```

Tests cover invocation provenance, caught CPI failures, exact atomic amounts, reconnect recovery, durable queues, missing transactions, repeated scans, reorg removals, batch proofs, fee differences, and forbidden RPC methods. `check:public` conservatively scans repository files for unproven key literals, serialized signing keys, credentials, and runtime files. `verify:public` fetches the live transparency page and its published IDL, then checks them against the pinned manifest without executing site JavaScript or changing files.

The runtime RPC allowlists contain no transfer, signing, broadcast, spend-key, seed, or transaction-key export methods. Proof keys enter the database only from finalized bridge events or program-owned finalized audit accounts. Database, wallet, log, environment files, and installed dependencies are excluded from Git. No runtime or wallet data is bundled in this repository.

Protocol references: [published wXMR transparency information](https://wxmr.io/transparency), [Monero wallet RPC](https://www.getmonero.org/resources/developer-guides/wallet-rpc.html), [view-only wallet and proof limitations](https://docs.getmonero.org/interacting/monero-wallet-cli-reference/), [Solana finalized history](https://solana.com/docs/rpc/http/getsignaturesforaddress), and [Solana log subscriptions](https://solana.com/docs/rpc/websocket/logssubscribe).
