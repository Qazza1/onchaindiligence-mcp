/**
 * paymentAuthorization.ts — narrow ERC-3009 authorization identity (D2.4,
 * Section 6/8).
 *
 * x402's "exact" EVM scheme has the buyer sign an EIP-3009
 * `transferWithAuthorization` meta-transaction off-chain; the facilitator
 * (a third-party relayer) submits it on-chain as the transaction's `to`
 * being the token contract itself — the relayer pays gas, but the
 * `authorizer` and `nonce` embedded in the calldata are the buyer's own.
 * This module decodes exactly those two fields directly from the on-chain
 * transaction's own input data — never from a caller's claim — so they can
 * be compared against a frozen `expected_payer` commitment (see
 * commerceLifecycle.ts).
 *
 * This does NOT claim the authorization contains OCD policy or
 * purchased-resource semantics — it contains only what EIP-3009 defines:
 * who authorized moving how much, to whom, within what validity window,
 * under what nonce. Decode failure (unrecognized calldata shape — a
 * different scheme, a wrapping contract, a malformed transaction) always
 * returns `null`, never a fabricated or partial identity.
 */
import { decodeFunctionData, type Hex } from 'viem'

// The canonical EIP-3009 transferWithAuthorization signature, as implemented
// by Circle's USDC (the only settlement asset D2.2/D2.4 support — see
// settlement.ts). https://eips.ethereum.org/EIPS/eip-3009
const TRANSFER_WITH_AUTHORIZATION_ABI = [
  {
    type: 'function',
    name: 'transferWithAuthorization',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
      { name: 'v', type: 'uint8' },
      { name: 'r', type: 'bytes32' },
      { name: 's', type: 'bytes32' },
    ],
    outputs: [],
  },
] as const

export interface DecodedPaymentAuthorization {
  /** The wallet that signed the authorization -- NOT necessarily the transaction sender (a relayer usually submits on their behalf). */
  authorizer: string
  /** The EIP-3009 nonce, as a 0x-prefixed 32-byte hex string. Unique per authorization by construction; never reused across two distinct authorizations. */
  nonce: string
  recipient: string
  valueAtomic: bigint
}

/**
 * Attempts to decode a transaction's calldata as an ERC-3009
 * transferWithAuthorization call. Returns null on ANY decode failure
 * (wrong selector, malformed data, wrong argument count) — this is
 * expected and normal whenever the transaction used a different mechanism,
 * and callers must treat null as "no independently-verified payment
 * authorization identity available", never as an error.
 */
export function decodeErc3009Authorization(inputData: Hex): DecodedPaymentAuthorization | null {
  try {
    const decoded = decodeFunctionData({ abi: TRANSFER_WITH_AUTHORIZATION_ABI, data: inputData })
    if (decoded.functionName !== 'transferWithAuthorization') return null
    const [from, to, value, , , nonce] = decoded.args
    return { authorizer: from, recipient: to, valueAtomic: value, nonce }
  } catch {
    return null
  }
}
