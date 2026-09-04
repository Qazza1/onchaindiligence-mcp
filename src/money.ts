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

/**
 * Converts a canonical decimal amount string to exact atomic units (BigInt)
 * for a token with `decimals` decimal places — e.g. ("1.50", 6) -> 1500000n.
 * Callers MUST validate `amount` with `isCanonicalDecimalAmount` first.
 *
 * Returns `null`, rather than rounding, when `amount` carries more
 * fractional precision than the asset supports (e.g. "1.1234567" against 6
 * decimals) — D2.2 settlement verification must never silently round a
 * human-supplied amount into a different on-chain value.
 */
export function decimalAmountToAtomicUnits(amount: string, decimals: number): bigint | null {
  const [intPart, fracPart = ''] = amount.split('.')
  if (fracPart.length > decimals) return null
  const paddedFrac = fracPart.padEnd(decimals, '0')
  return BigInt(intPart + paddedFrac)
}

/** The inverse of decimalAmountToAtomicUnits — atomic units back to a canonical decimal string. */
export function atomicUnitsToDecimalAmount(atomicUnits: bigint, decimals: number): string {
  const negative = atomicUnits < 0n
  const digits = (negative ? -atomicUnits : atomicUnits).toString().padStart(decimals + 1, '0')
  const intPart = digits.slice(0, digits.length - decimals) || '0'
  const fracPart = decimals > 0 ? digits.slice(digits.length - decimals) : ''
  const trimmedFrac = fracPart.replace(/0+$/, '')
  const sign = negative ? '-' : ''
  return trimmedFrac ? `${sign}${intPart}.${trimmedFrac}` : `${sign}${intPart}`
}
