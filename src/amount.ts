/**
 * Coerce a SATIM amount input — a DZD number/string, a minor-unit bigint, or a
 * `Dinar` (anything with `toCentimes()`) — to integer centimes. Mirrors how the
 * real satim client normalizes amounts, without taking a runtime dinar dependency.
 */
export function toCentimes(amount: number | string | bigint | { toCentimes(): number }): number {
  if (typeof amount === 'object' && amount !== null && typeof amount.toCentimes === 'function') {
    return amount.toCentimes();
  }
  if (typeof amount === 'bigint') return Number(amount);
  return Math.round(Number(amount) * 100);
}
