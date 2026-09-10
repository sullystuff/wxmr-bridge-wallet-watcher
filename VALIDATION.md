# Initial validation — 2026-09-10

- Node.js 22.21.0; Monero wallet RPC 0.18.4.5.
- All 24 automated tests passed, including public-log provenance, precise amounts, durable restart/retry behavior, batch payout checks, reorg handling, socket reconnects, and cancellation during a rate-limit wait.
- `npm run verify:public` matched the pinned address, view key, program, mint, and IDL to the publicly served wxmr.io transparency page and JavaScript.
- `npm run check:public` passed. A separate scan of all existing Git-history blobs found no unproven key-sized literals, serialized signing keys, or runtime files. The only bundled key is the published view key in the manifest.
- `npm audit --omit=dev` reported zero vulnerabilities after updating the WebSocket dependency.

The live check used public Solana RPC and a newly generated, separate Monero view-only wallet. It scanned from Monero height **3,756,000** through **3,759,689**, detected **208 incoming outputs**, and checked **23 published payment records** with positive confirmed Monero payment evidence. The public deposit address discovered during the bounded Solana history replay resolved successfully in this view wallet. No unresolved decoding errors remained among the fetched Solana transactions.

The live data exercised withdrawal fee deductions, aggregate mint events, and public consolidation proofs. The first version of the JSON parser rejected long decimal `uiAmount` fields in otherwise valid Solana responses; the final version preserves long numeric tokens as strings, with a regression test. Integer atomic amounts remain exact.

The public Solana endpoint rejected `getProgramAccounts` with HTTP 403. Transaction-history fallback continued successfully, with the snapshot limitation visible in status. A live finalized `logsSubscribe` connection was acknowledged successfully. Shutdown of the full CLI completed with exit code 0 in under one second and removed its writer lock.

This was a bounded integration check. Historical Solana backfill remained queued; it was not a complete audit of every deposit, withdrawal, or reserve. All temporary watcher and Monero wallet processes were stopped afterward, and the temporary wallet port and process locks were verified closed/removed. No service is installed or left running by these checks.
