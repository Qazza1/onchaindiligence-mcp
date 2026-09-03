/**
 * money.ts — deterministic decimal-string arithmetic for payment amounts.
 *
 * Amounts are canonical decimal strings (e.g. "1.00", "0.5") — never
 * JavaScript numbers, which cannot represent money exactly and would make
 * amount comparisons non-deterministic across runtimes. Canonical form here
 * means: no leading zeros (except a bare "0"), no leading "+", no scientific
 * notation, and a decimal point only when a fractional part is present.
 * Comparison operates on the digits directly — no float conversion anywhere.
 */

const CANONICAL_DECIMAL = /^(0|[1-9]\d*)(\.\d+)?$/
const MAX_LENGTH = 40 // generous; rejects absurd/DoS-shaped inputs, not real amounts

export function isCanonicalDecimalAmount(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_LENGTH && CANONICAL_DECIMAL.test(value)
}

/**
 * Deterministic three-way compare of two canonical decimal amount strings.
 * Callers MUST validate both inputs with `isCanonicalDecimalAmount` first —
 * this function does not re-validate, to keep it a pure, cheap comparator.
 */
export function compareDecimalAmounts(a: string, b: string): -1 | 0 | 1 {
  const [aInt, aFrac = ''] = a.split('.')
  const [bInt, bFrac = ''] = b.split('.')

  // Canonical integer parts carry no leading zeros, so longer == larger.
  if (aInt.length !== bInt.length) return aInt.length < bInt.length ? -1 : 1
  if (aInt !== bInt) return aInt < bInt ? -1 : 1

  const fracLen = Math.max(aFrac.length, bFrac.length)
  const aFracPadded = aFrac.padEnd(fracLen, '0')
  const bFracPadded = bFrac.padEnd(fracLen, '0')
  if (aFracPadded === bFracPadded) return 0
  return aFracPadded < bFracPadded ? -1 : 1
}

/** True when `amount <= max`, using exact decimal-string comparison. */
export function isAmountWithinMax(amount: string, max: string): boolean {
  return compareDecimalAmounts(amount, max) <= 0
}
