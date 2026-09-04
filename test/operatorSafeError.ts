/** D2.2B1 tests for operator/src/safeError.ts's allowlisted 402-detail extraction.
 *
 * Run with: npx tsx test/operatorSafeError.ts
 *
 * Fully offline: operates on plain fabricated JSON bodies, no fetch/DOM. The
 * point of this test is the NEGATIVE guarantee — a body carrying
 * signature/payload/capability material must never surface in the returned
 * string, no matter what field name it's under.
 */
import assert from 'node:assert/strict'
import { extractSafe402Detail } from '../operator/src/safeError.js'

// --- allowlisted fields are surfaced -----------------------------------
{
  const msg = extractSafe402Detail({ error: "'paymentPayload' is invalid: must match one of [x402V2PaymentPayload, x402V1PaymentPayload]" }, 'preflight-payment')
  assert.ok(msg.includes('preflight-payment'))
  assert.ok(msg.includes('error:'))
  assert.ok(msg.includes('paymentPayload'))
}
{
  const msg = extractSafe402Detail({ errorReason: 'insufficient_funds' }, 'screen_wallet target service')
  assert.ok(msg.includes('errorReason: insufficient_funds'))
}
{
  const msg = extractSafe402Detail({ invalidReason: 'unsupported_scheme' }, 'preflight-payment')
  assert.ok(msg.includes('invalidReason: unsupported_scheme'))
}
{
  // Multiple recognized fields are all surfaced, not just the first.
  const msg = extractSafe402Detail({ error: 'top-level rejection', errorReason: 'nested reason' }, 'preflight-payment')
  assert.ok(msg.includes('error: top-level rejection'))
  assert.ok(msg.includes('errorReason: nested reason'))
}
console.log('ok  allowlisted error/errorReason/invalidReason fields are surfaced with the route label')

// --- unparseable / empty / non-object bodies degrade to a generic message ---
assert.ok(extractSafe402Detail(null, 'preflight-payment').includes('could not be safely parsed'))
assert.ok(extractSafe402Detail(undefined, 'preflight-payment').includes('could not be safely parsed'))
assert.ok(extractSafe402Detail('not an object', 'preflight-payment').includes('could not be safely parsed'))
assert.ok(extractSafe402Detail({}, 'preflight-payment').includes('no recognized error field'))
assert.ok(extractSafe402Detail({ someOtherField: 'x' }, 'preflight-payment').includes('no recognized error field'))
console.log('ok  unparseable/empty/unrecognized bodies degrade to a generic 402 message, never throw')

// --- THE critical negative guarantee: forbidden fields never leak, under any name ---
const DANGEROUS_BODY = {
  error: 'safe top-level reason',
  'PAYMENT-SIGNATURE': '0xDEADBEEF_SIGNATURE_MATERIAL',
  paymentPayload: {
    payload: { authorization: { from: '0xabc', to: '0xdef', value: '10000', nonce: '0x1' }, signature: '0xSECRETSIG' },
  },
  finalization: { capability: 'super-secret-capability-token' },
  authorization: 'Bearer super-secret-capability-token',
  privateKey: '0xPRIVATEKEYMATERIAL',
  headers: { 'x-payment': '0xSIGNED_PAYLOAD' },
}
const dangerousMsg = extractSafe402Detail(DANGEROUS_BODY, 'preflight-payment')
for (const forbidden of [
  'PAYMENT-SIGNATURE',
  '0xDEADBEEF_SIGNATURE_MATERIAL',
  'authorization',
  '0xSECRETSIG',
  'super-secret-capability-token',
  '0xPRIVATEKEYMATERIAL',
  '0xSIGNED_PAYLOAD',
  'privateKey',
  'paymentPayload',
]) {
  assert.ok(!dangerousMsg.includes(forbidden), `forbidden field/value leaked into safe 402 message: ${forbidden}`)
}
assert.ok(dangerousMsg.includes('safe top-level reason'), 'the one allowlisted field must still come through')
console.log('ok  PAYMENT-SIGNATURE, payment authorization payload, capability, and private key material never leak regardless of field name')

console.log('\nAll D2.2B1 operator-safe-error tests passed.')
