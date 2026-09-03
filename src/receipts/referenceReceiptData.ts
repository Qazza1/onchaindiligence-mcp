/**
 * Fixed, public-safe projection of the committed P1.8 production reference
 * bundle. This is the only receipt the temporary bootstrap may ever sign.
 * It deliberately records a withheld action: it is not a payment receipt.
 */
import {
  buildReceiptCore,
  finalizeReceiptCore,
  type Receipt,
  type ReceiptCoreFields,
} from '../receipts.js'

export const REFERENCE_RECEIPT_CORE: ReceiptCoreFields = buildReceiptCore({
  receipt_type: 'ACTION',
  issued_at: '2026-08-28T19:53:51.415Z',
  action: {
    kind: 'planned-financial-transfer',
    resource: 'AAPL counterparty preflight',
    network: 'ethereum-mainnet',
    asset: 'pathUSD',
    amount: '1.00',
    sender: null,
    recipient: '0x000000000000000000000000000000000000dEaD',
  },
  decision: {
    status: 'REQUIRE_APPROVAL',
    authorized: false,
    reasons: [
      'Recipient wallet was not bound to the resolved SEC filer.',
      'Independent public observations do not establish a wallet-to-company identity relationship.',
    ],
  },
  execution: {
    provider: 'OnChainDiligence Agent Evidence P1.8 reference workflow',
    status: 'NOT_SUBMITTED',
    transaction_hash: null,
    submitted_at: null,
    confirmed_at: null,
  },
  settlement: {
    status: 'NOT_APPLICABLE',
    detail: 'No execution was submitted; no value settlement occurred.',
  },
  checks: [
    {
      id: 'recipient-wallet-not-sanctioned',
      result: 'PASS',
      summary: 'The public burn address was reported not sanctioned by the Chainalysis oracle at the recorded observation time.',
      evidence_digest: 'sha256:-1OOwqRghEqt0CUdq9EO-49aUlWnRBTRj1QDODO9GqA',
    },
    {
      id: 'counterparty-sec-filer-resolved',
      result: 'PASS',
      summary: 'AAPL was resolved to Apple Inc. through SEC EDGAR at the recorded observation time.',
      evidence_digest: 'sha256:cvd9KFwcUlJY_obJrR6OdwFY2Q3wQJSwvp_8yv1wa6U',
    },
    {
      id: 'recipient-wallet-bound-to-counterparty',
      result: 'FAIL',
      summary: 'No public evidence in this run established that the recipient wallet belongs to the resolved SEC filer.',
      evidence_digest: null,
    },
  ],
  links: {
    agent_evidence_bundle_digest: 'sha256:b3Y51kb7-JfTCzA-MbVBHAiLdo43xlJLpAbT4eed6rw',
    preflight_receipt_id: null,
  },
  limitations: [
    'A valid receipt proof does not prove every underlying evidence statement is objectively true.',
    'Execution was not submitted.',
    'No value settlement occurred.',
    'Wallet and company identity bindings are not implied unless separately proven.',
  ],
})

export const REFERENCE_RECEIPT: Receipt = finalizeReceiptCore(REFERENCE_RECEIPT_CORE)
export const REFERENCE_RECEIPT_ID = 'OCD-RCP-EMG6-6KR4-PQSG-MZPQ'
export const REFERENCE_RECEIPT_DIGEST = 'sha256:dSBjTwS18wp-15gRHOmTW_2zUKOaXjH9pil1hJcNclY'

if (
  REFERENCE_RECEIPT.receipt_id !== REFERENCE_RECEIPT_ID ||
  REFERENCE_RECEIPT.receipt_digest !== REFERENCE_RECEIPT_DIGEST
) {
  throw new Error('fixed reference receipt constants do not match the finalized receipt')
}
