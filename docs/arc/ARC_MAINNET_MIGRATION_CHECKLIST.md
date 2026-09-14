# Arc Mainnet migration checklist — 2026-09-16

This Testnet research branch is not a Mainnet authorization. Before any Mainnet code or transaction, re-check the then-current official Arc documentation and record the source URL and retrieval date for every value below.

## Pre-launch status check — 2026-09-14 (D3.5C3-MAINNET-PRE)

Two days before the announced public launch. Checked only official sources
(`docs.arc.io`, `circle.com/pressroom`, `developers.circle.com`) — no
third-party aggregator values used, several of which disagreed with each
other and with the official docs (chain ID `5042` vs `1243` seen across
different aggregators for what they each called "Arc Mainnet").

- **Arc is on private mainnet only.** Circle's own August 2026 press release:
  "Arc is currently in private mainnet with more than 100 ecosystem and
  institutional builders" and "on track for a public mainnet launch on
  September 16, 2026."
- `docs.arc.io/arc/references/rpc-endpoints`, verbatim: *"The values on this
  page apply to the Arc Testnet. Mainnet endpoints and parameters are
  published separately when available."* No mainnet RPC exists to check yet.
- `docs.arc.io/arc/references/contract-addresses`, verbatim: *"All addresses
  on this page are for Arc Testnet... Mainnet addresses are not yet
  available."*
- No official Arc mainnet chain ID, CAIP-2 identifier, RPC URL, or block
  explorer has been published anywhere on an official Circle/Arc domain as of
  this check. Every specific mainnet chain ID or RPC URL seen in this
  research came only from third-party aggregators (chainlist-style sites,
  RPC resellers) that disagreed with each other — none is used here.
- Circle's `LIVE_API_KEY:` prefix distinguishes Circle's own
  production/sandbox API environment generally (used across every chain
  Circle's APIs touch), not Arc-Public-Mainnet access specifically. A
  developer whose Circle account already has `LIVE_API_KEY` access should
  **not** assume that implies Arc Public Mainnet access — Circle's own docs
  give no indication these are the same gate.
- Arc's CCTP quickstart (`developers.circle.com/cctp/quickstarts/transfer-usdc-ethereum-to-arc.md`)
  is testnet-only: domain ID `26`, sandbox IRIS API endpoint, no mainnet
  domain ID or endpoint given.
- Could not inspect the account owner's own Circle Developer Console
  (`console.circle.com`) — no console credentials or connector are available
  to this session. If the owner's console already shows an Arc-specific
  mainnet section, that needs a human read-only check; a generic "Mainnet"
  toggle in the console is Circle's own environment switch, not
  confirmation of Arc Public Mainnet specifically.
- No code change is required today. `src/arc/config.ts` already reads every
  value from `ARC_*` env vars with Testnet defaults; the day-1 migration is
  an env var override, not a code change, once official mainnet values are
  published.

- [ ] Chain ID, CAIP-2, canonical RPC and block explorer.
- [ ] Finality guarantee and the exact OCD confirmation/finality evaluator. Do not carry over the Testnet one-confirmation policy by assumption.
- [ ] Native gas asset and canonical payment asset, including ERC-20 address and decimals where applicable.
- [ ] ERC-8004 Identity, Reputation and Validation registry addresses and deployed interface versions.
- [ ] ERC-8183 deployment address, bytecode/interface version and job-status mapping.
- [ ] Any Circle/CCTP integration identifiers only if the planned flow actually uses them.
- [ ] Read-only smoke tests against the selected RPC and contracts, including one historical identity and job if public examples exist.
- [ ] Reconcile native-gas and ERC-20 balance units from official Mainnet documentation; never infer decimals from the Testnet display behaviour.
- [ ] Revalidate registration-file requirements against the then-current ERC-8004 draft/final standard and Arc deployment version.
- [ ] Revalidate who is permitted to set an ERC-8183 budget and every function signature against the deployed Mainnet bytecode/ABI.
- [ ] Define operational custody, rotation, backup and revocation procedures for any Mainnet identity owner or validator key. Disposable Testnet EOAs are prohibited.
- [ ] Define an explicit validator trust policy. An ERC-8004 numeric response must remain registry evidence and must not be translated to OCD `VALID`.
- [ ] Preserve ERC-8183 evaluator provenance; `Completed` must not be presented as independently verified service delivery.
- [ ] Set Mainnet monetary and gas budgets, transaction simulation requirements, and human approval gates.
- [ ] A separate owner approval for registration, claims, funding and each Mainnet transaction.

Remove faucet assumptions. Testnet identities, metadata and transaction history do not migrate. Unknown Mainnet values remain `TBD`; no fallback to Testnet values is permitted.
