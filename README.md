# wXMR public wallet watcher

An independent observer of wXMR deposits and withdrawals using information published at [wxmr.io/transparency](https://wxmr.io/transparency) and by its Solana bridge program.

The only bundled key is the **published Monero view key**. Its public source, retrieval time, program identity, and the public IDL checksum are recorded in `public/mainnet.json`. No spend key, seed, Solana signing key, production database, or production environment file is used.

Requires Node.js 22.13 or newer. Install with `npm ci`. Run `npm test`, `npm run check:public`, and `npm run verify:public` to check the decoder, RPC restrictions, repository contents, and current public-source provenance.

Implementation is being added in tested commits. Runtime instructions follow with the watcher and dedicated view-wallet runner.
