# ERC-20 Allowance / Revocation (D3.6A)

This is OCD's second strict consequential action. It is **not** a payment
record and does not alter `onchaindiligence.public-action-receipt.v1`.

## Scope and action

Initial production scope is canonical Circle USDC on Base (`eip155:8453`,
`0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, six decimals). Amounts are
canonical uint256 atomic-unit strings. An action freezes an optional owner,
spender, amount, `SET_ALLOWANCE` or `REVOKE`, policy, UTC creation time, and
opaque `OCD-ALW-…` operation id. `REVOKE` is only `approve(spender, 0)`.

`uint256.max` is recognized as unlimited. It is `REQUIRE_APPROVAL` unless
the policy explicitly says `ALLOW`, and is blocked when the policy says
`BLOCK`.

## API and MCP

- `POST /inspect/allowance` / `inspect_allowance`: free deterministic policy inspection.
- `POST /x402/preflight-allowance` / `preflight_allowance`: paid signed preflight.
- `POST /allowances/observe` / `observe_allowance`: consume a signed preflight
  artifact plus transaction hash; OCD reads Base itself and returns a signed
  observation artifact.
- `POST /verify-allowance-action`: verifies a portable artifact against the
  public key registry.

The signed artifact purpose is `erc20-allowance-action`. It is portable but
not currently persisted in the payment-only operation store; callers must
retain it and its returned observation artifact. No wallet key, custody, or
wallet-authority path is introduced.

## Evidence and reconciliation

OCD requires a successful transaction and a canonical-USDC `Approval(owner,
spender,value)` log. It records the exact log index/block/transaction, runs
the existing `base-usdc-safe-head.v1` finality policy, and when the RPC can
serve it reads `allowance(owner, spender)` at the approval block. That
historical post-state remains distinct from the event; later mutable state is
not treated as a contradiction.

`SPENDER_MISMATCH` and `ALLOWANCE_MISMATCH` are the two additive D3.3 codes:
using payment `RECIPIENT_MISMATCH` or `AMOUNT_MISMATCH` here would be false
semantics. Missing finalized attributable approval evidence is an existing
insufficient-evidence finding. Payment binding strengths are not claimed.

## Limits

An ALLOW is a policy result, not wallet authorization. An Approval event does
not establish service delivery, counterparty legitimacy, later spender use,
or token-contract safety. The initial observer does not support arbitrary
tokens or networks.

Sources: [ERC-20](https://eips.ethereum.org/EIPS/eip-20), [Base RPC
overview](https://docs.base.org/base-chain/api-reference/rpc-overview), and
[Circle USDC addresses](https://developers.circle.com/stablecoins/usdc-contract-addresses).
