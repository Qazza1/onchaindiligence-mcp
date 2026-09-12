# Arc Mainnet migration checklist — 2026-09-16

This Testnet research branch is not a Mainnet authorization. Before any Mainnet code or transaction, re-check the then-current official Arc documentation and record the source URL and retrieval date for every value below.

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
