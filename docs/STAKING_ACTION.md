# D3.6D Lido stETH staking action profile

`onchaindiligence.staking-action.v1` is a signed portable artifact for one narrow consequential action: an Ethereum Mainnet ETH submission to Lido's canonical stETH proxy using its `submit(address)` flow.

The action is strict: `kind: STAKE`, `protocol: lido-steth-submit`, `network: eip155:1`, `input_asset: eip155:1/slip44:60`, exact `staker`, and a positive wei-string ceiling. Policies can constrain only network, protocol, exact staker, and maximum wei amount. An unconstrained policy must explicitly acknowledge that fact.

The observer reads the Ethereum transaction and receipt independently. It requires a successful transaction to the canonical Lido proxy and exactly one canonical `Submitted(sender, amount, referral)` event. It checks `Submitted.sender == transaction.from` and `Submitted.amount == transaction.value`; disagreement yields insufficient evidence, never a reconciled result. `TransferShares(from, to, sharesValue)` is recorded only when one unambiguous mint-like event can be isolated. Shares are corroboration and are never compared to ETH numerically.

Reconciliation has one staking-specific contradiction: `STAKER_MISMATCH`. It otherwise reuses `AMOUNT_MISMATCH` and `SETTLEMENT_NOT_INDEPENDENTLY_CONFIRMED`. Missing, reverted, unfinalized, unavailable, malformed, or internally inconsistent evidence is an evidence gap, never a contradiction.

The artifact proves signed content integrity only when verification returns `VALID`. It confirms only the observed Lido submission transaction. It does not establish current stETH value, yield/APY, economic safety, slashing/peg/smart-contract risk, or withdrawal/unstake/claim behavior.

## Read-only Mainnet fixture

The observer was smoke-tested against a historical direct Mainnet submission, not a test transaction:

- transaction: `0x01682c6164969c53e26f3a5342b94863cf2ec6e50a4f87c09692cf72afe17680`
- block: `25963399` / `0xe1858b8380ff12ccd3b525fb4100015570d869b7d31312f47651ce83c6668002`
- `Submitted.sender` and `transaction.from`: `0xC844571663C030f16c1c2A73665092e21F1fa0e7`
- `Submitted.amount` and `transaction.value`: `4200000000000000000` wei
- referral: `0x6DC9657C2D90D57cADfFB64239242d06e6103E43`
- unambiguous mint-like `TransferShares`: `3376560296457196784` shares
- finality: Ethereum finalized-head policy reported `safe` at the time of observation.
