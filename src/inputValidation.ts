/** Side-effect-free input validation for pre-payment route guards. */
export function isValidAddressOrEns(input: string): boolean {
  const value = input.trim()
  const isAddress = /^0x[0-9a-fA-F]{40}$/.test(value)
  const isEns = /\.(eth|xyz|com|org|io|app|art)$/i.test(value)
  return value.length <= 255 && (isAddress || isEns)
}
