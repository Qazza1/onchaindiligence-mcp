# OCD operator commerce UI — LOCAL ONLY (D2.2B)

Browser-wallet front end for the first real OCD commerce lifecycle. Replaces the
`BUYER_PRIVATE_KEY` terminal workflow in `scripts/first-commerce-lifecycle.ts` with an
injected wallet (MetaMask / Rabby / Coinbase Wallet) that signs both payments itself. No
private key ever touches this tool.

This directory is **not deployed**. `index.ts` (the Vercel entrypoint) never imports
anything under `operator/`, so production continues to 404 on any `/operator/*` path — this
is a plain local dev tool, started by hand.

## Run it

```
npm run operator:commerce
```

This bundles `operator/src/main.ts` with esbuild, then starts a local server at
`http://localhost:5757/` (override with `OPERATOR_PORT`). Open that URL in a browser with
an injected wallet extension installed.

## How it avoids touching the live API's CORS

The browser only ever calls `http://localhost:5757/...` — same-origin. That local server
reverse-proxies exactly five fixed upstream paths to `https://mcp.onchaindiligence.com`
(the two payment resources, free inspection, finalize, and receipt lookup) and forwards
headers/bodies verbatim. No CORS change was made to the production API to build this tool.

## What it does NOT do

- Never asks for a private key, seed phrase, or raw signing material — the wallet signs.
- Never persists the finalization capability anywhere (no localStorage/sessionStorage/
  IndexedDB/URL/console.log) — it lives in one browser-memory variable, cleared right
  after the single finalize request that consumes it, and is lost on refresh by design.
- Never allows a third paid call or lets the two payments exceed $0.01 each / $0.02
  total — enforced by the same `src/lifecycleCore.ts` safety gates the terminal script
  uses, not a second, divergent copy of that logic.
