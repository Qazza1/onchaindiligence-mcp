/**
 * Shared hostile-but-plausible upstream response shapes.
 *
 * These deliberately model HTTP 200 bodies that are malformed, incomplete,
 * or error-shaped. Adapters may reject them or return a conservative state,
 * but must never manufacture a clean/confirmed result from failed parsing.
 */
export const MALFORMED_UPSTREAM_RESPONSES: ReadonlyArray<readonly [string, unknown]> = [
  ['empty object', {}],
  ['null', null],
  ['wrong scalar type', 'not-a-record'],
  ['wrong field types', { status: true, blockNumber: '12', logs: 'not-an-array' }],
  ['error-shaped HTTP 200', { error: { code: 'UPSTREAM_FAILURE', message: 'temporary failure' } }],
  ['partial record', { status: 'success', blockNumber: 12n, blockHash: '0x1234' }],
]

export async function assertConservative<T>(
  label: string,
  operation: () => Promise<T>,
  isPositive: (value: T) => boolean,
): Promise<void> {
  try {
    const value = await operation()
    if (isPositive(value)) {
      throw new Error(`${label}: malformed upstream data produced a positive result`)
    }
  } catch (error) {
    // Explicit rejection is a valid fail-closed outcome. Do not swallow the
    // assertion above: it identifies a genuine false-pass regression.
    if (error instanceof Error && error.message.includes('produced a positive result')) throw error
  }
}
