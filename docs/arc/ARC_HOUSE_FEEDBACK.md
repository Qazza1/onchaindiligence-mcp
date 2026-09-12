# Arc Testnet feedback

## Scope

OnChainDiligence is evaluating Arc Testnet as a read-only evidence and reconciliation source for agent identity and job-settlement claims. This is not a Mainnet endorsement, custody integration, payment-provider partnership, safety claim, or service-delivery verification claim.

## Findings from the current official quickstarts

- Arc documents standard EVM JSON-RPC methods, chain ID `5042002`, USDC as currency symbol, and Arcscan as the Testnet explorer. On 2026-09-12, the official primary Testnet endpoint is `https://rpc.testnet.arc.io`; OCD's default was corrected from the earlier `.network` value while preserving `ARC_RPC_URL` override support. Endpoint names have drifted during this research, so integrations should verify this value at release time.
- The documented ERC-8004 identity, reputation and validation registries are modeled as separate evidence sources. Identity ownership and metadata URI are independently readable; reputation and validation records remain registry/attester claims.
- Validation response `100` is a registry response, not OCD `VALID`, a safety score, or proof of underlying behaviour.
- The documented ERC-8183 reference flow is: create job, set budget, approve/fund USDC escrow, submit a deliverable hash, then complete. `Completed` is a contract lifecycle state, not independent proof of real-world service delivery.
- Arc describes deterministic finality. OCD records the configured Testnet finality policy explicitly; it does not infer facts beyond the observed chain state.

## Useful product feedback to Arc

1. Publish versioned, machine-readable ABI/address manifests for each Testnet reference contract, including ERC-8183 status semantics.
2. Keep one canonical RPC hostname in quickstarts and network references, with a deprecation notice during endpoint migrations.
3. Include a public historical transaction for every quickstart stage so independent observers can test decoding without creating testnet state.

Beta feedback may earn points only when Arc explicitly approves it. Testnet transactions are not treated as automatic points.
