/** Side-effect-free input validation for pre-payment route guards. */
export function isValidAddressOrEns(input: string): boolean {
  const value = input.trim()
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(value)
  const isEns = /\.(eth|xyz|com|org|io|app|art)$/i.test(value)
  return value.length <= 255 && (isAddress || isEns)
}

/**
 * Strict EVM address. Used where the underlying check does NOT resolve ENS
 * (the Chainalysis oracle read takes a raw 20-byte address), so accepting an
 * ENS name here would only produce a paid-for failure.
 */
export function isValidEvmAddress(input: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(input.trim())
}

/**
 * UK Companies House registration number. Canonically 8 characters: either 8
 * digits, or a 2-letter prefix (SC/NI/OC/…) followed by 6 digits. Older
 * records can be shorter before zero-padding, so this stays deliberately
 * permissive about length while still rejecting free text and path tricks.
 */
export function isValidUkCompanyNumber(input: string): boolean {
  return /^[A-Za-z0-9]{6,8}$/.test(input.trim())
}

/**
 * A name to screen against the OFAC SDN list. Only rejects the cases that
 * cannot possibly produce a meaningful screen (empty, or absurdly long) —
 * matching quality itself is the screening engine's job, not a route guard.
 */
export function isValidScreeningName(input: string): boolean {
  const value = input.trim()
  return value.length >= 2 && value.length <= 255
}
